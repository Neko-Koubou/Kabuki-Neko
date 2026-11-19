-- Redis room layout v2 (ADR-13, SA §6.1.1): room lifecycle, reads, leases and the frozen report.
--
-- KEYS (all in the room's hash slot {PIN}, prefix kabukineko:<ns>:v2:room:{PIN}):
--   1 :meta  (hash: sessionId, core, quiz, expiresAt, durable)   2 :join-receipts   3 :lease
--   4 :players (hash playerId -> ActivePlayer)                   5 :commands        6 :tickets
--   7 :report (string FrozenReport)
-- Per-question keys :answers:<q> (hash playerId -> StoredAnswer), :closed:<q> and :result:<q>
-- (strings) are built from the validated prefix: they share the {PIN} hash tag, so they live in
-- the same slot as the declared keys.
-- ARGV: sessionId, JSON operation.
--
-- Only `core` (small) and `quiz` (once per release) are ever decoded here; per-player and
-- per-question pieces are copied as stored strings. Redis cjson writes empty arrays as {}; the
-- typed adapter restores schema-declared arrays when it reads the pieces back.
local session = ARGV[1]
local op = cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 7 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease'
  or KEYS[4] ~= prefix .. ':players' or KEYS[5] ~= prefix .. ':commands'
  or KEYS[6] ~= prefix .. ':tickets' or KEYS[7] ~= prefix .. ':report' then
  return err('INVALID_REFERENCE')
end
local META, LEASE, PLAYERS, COMMANDS, TICKETS, REPORT = KEYS[1], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]
-- Keys of one question (same slot as every declared key).
local function answersKey(q) return prefix .. ':answers:' .. q end
local function closedKey(q) return prefix .. ':closed:' .. q end
local function resultKey(q) return prefix .. ':result:' .. q end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

-- Every room key belongs to this session or to nobody (PIN reuse / late cleanup protection).
for _, key in ipairs({META, KEYS[2], LEASE}) do
  local owner = redis.call('HGET', key, 'sessionId')
  if owner and owner ~= session then
    if op.kind == 'read' then return {} end
    if op.kind == 'acquireLease' or op.kind == 'renewLease' or op.kind == 'releaseLease' or op.kind == 'releaseRoom' then
      return cjson.encode({result=false})
    end
    return err('ROOM_NOT_FOUND')
  end
end

-- Copies the meta key's physical expiry onto `key` (persistent while meta is persistent).
local function followTtl(key)
  local at = redis.call('PEXPIRETIME', META)
  if at > 0 then redis.call('PEXPIREAT', key, at) else redis.call('PERSIST', key) end
end
-- Writes every field of a Lua table into a hash (JSON value per field) and aligns its expiry.
local function writeHash(key, entries)
  local any = false
  for field, value in pairs(entries) do
    redis.call('HSET', key, field, cjson.encode(value)); any = true
  end
  if any then followTtl(key) end
end
-- Stored hash as a flat array {field, value, ...} of raw JSON strings (no decoding).
local function flat(key) return redis.call('HGETALL', key) end

if op.kind == 'create' then
  if redis.call('EXISTS', META) == 1 then return cjson.encode({result='EXISTS'}) end
  local parts = op.parts
  local core = parts.core
  if core.sessionId ~= session or prefix:sub(-7, -2) ~= core.pinCode or type(op.ttlMs) ~= 'number' or op.ttlMs <= 0 then
    return err('INVALID_REFERENCE')
  end
  local expiry = math.min(now + op.ttlMs, core.hardExpiresAt)
  redis.call('HSET', META, 'sessionId', session, 'core', cjson.encode(core),
    'quiz', cjson.encode(parts.quiz), 'expiresAt', expiry, 'durable', '0')
  -- Physical TTL is a safety horizon; logical expiry is checked per operation.
  redis.call('PEXPIREAT', META, expiry + 86400000)
  writeHash(PLAYERS, parts.players)
  writeHash(COMMANDS, parts.commands)
  writeHash(TICKETS, parts.tickets)
  for q, byPlayer in pairs(parts.answers) do writeHash(answersKey(q), byPlayer) end
  for q, closed in pairs(parts.closedQuestions) do
    redis.call('SET', closedKey(q), cjson.encode(closed)); followTtl(closedKey(q))
  end
  for q, result in pairs(parts.results) do
    redis.call('SET', resultKey(q), cjson.encode(result)); followTtl(resultKey(q))
  end
  if parts.frozenReport ~= cjson.null then
    redis.call('SET', REPORT, cjson.encode(parts.frozenReport)); followTtl(REPORT)
  end
  return cjson.encode({result='CREATED'})
end

local rawCore = redis.call('HGET', META, 'core')
if op.kind == 'read' then
  -- Raw pieces of a consistent snapshot: {core, quiz, expiresAt, durable, now, players,
  -- commands, tickets, report|false, q1, answers1, closed1|false, result1|false, q2, ...}.
  -- mode 'window': current question + latest scored question; mode 'full': every question up to
  -- the current one plus every scored one.
  if not rawCore or redis.call('HGET', META, 'sessionId') ~= session then return {} end
  local core = cjson.decode(rawCore)
  local indices, seen = {}, {}
  local function add(q) if q ~= nil and q ~= cjson.null and not seen[q] then seen[q] = true; table.insert(indices, q) end end
  if op.mode == 'full' then
    if core.questionIndex ~= cjson.null then for q = 0, core.questionIndex do add(q) end end
    for _, q in ipairs(core.scoredQuestions) do add(q) end
  else
    add(core.questionIndex)
    local scored = core.scoredQuestions
    if #scored > 0 then add(scored[#scored]) end
  end
  local reply = {rawCore, redis.call('HGET', META, 'quiz'), redis.call('HGET', META, 'expiresAt') or '0',
    redis.call('HGET', META, 'durable') or '0', tostring(now), flat(PLAYERS), flat(COMMANDS),
    flat(TICKETS), redis.call('GET', REPORT)}
  for _, q in ipairs(indices) do
    table.insert(reply, tostring(q))
    table.insert(reply, flat(answersKey(q)))
    table.insert(reply, redis.call('GET', closedKey(q)))
    table.insert(reply, redis.call('GET', resultKey(q)))
  end
  return reply
end

-- Scheduler leases and the conditional release check presence and session through meta fields;
-- only the release reads the report, and nothing here decodes the core (TASK-185H rule kept).
if op.kind == 'acquireLease' or op.kind == 'renewLease' or op.kind == 'releaseLease' or op.kind == 'releaseRoom' then
  if not rawCore or redis.call('HGET', META, 'sessionId') ~= session then return cjson.encode({result=false}) end
  if op.kind == 'releaseRoom' then
    local core = cjson.decode(rawCore)
    if redis.call('EXISTS', REPORT) == 1 and (redis.call('HGET', META, 'durable') ~= '1'
      or core.finalization == cjson.null or core.finalization.status ~= 'ready') then
      return cjson.encode({result=false})
    end
    -- Every key by name: fixed keys plus each question's keys (no SCAN/KEYS).
    local quiz = cjson.decode(redis.call('HGET', META, 'quiz'))
    local doomed = {META, KEYS[2], LEASE, PLAYERS, COMMANDS, TICKETS, REPORT}
    for q = 0, #quiz.questions - 1 do
      table.insert(doomed, answersKey(q)); table.insert(doomed, closedKey(q)); table.insert(doomed, resultKey(q))
    end
    redis.call('DEL', unpack(doomed))
    return cjson.encode({result=true})
  end
  local owner = redis.call('HGET', LEASE, 'ownerId')
  local epoch = tonumber(redis.call('HGET', LEASE, 'epoch') or '0')
  local expiry = tonumber(redis.call('HGET', LEASE, 'expiresAt') or '0')
  if op.kind == 'releaseLease' then
    if owner ~= op.ownerId or epoch ~= op.epoch then return cjson.encode({result=false}) end
    redis.call('HDEL', LEASE, 'ownerId'); redis.call('HSET', LEASE, 'expiresAt', 0)
    return cjson.encode({result=true})
  end
  if type(op.ttlMs) ~= 'number' or op.ttlMs <= 0 or op.ttlMs % 1 ~= 0 then return err('INVALID_FORMAT') end
  if op.kind == 'acquireLease' then
    if owner and expiry > now then return cjson.encode({result=cjson.null}) end
    epoch = epoch + 1
  else
    if owner ~= op.ownerId or epoch ~= op.epoch or expiry <= now then return cjson.encode({result=false}) end
  end
  redis.call('HSET', LEASE, 'sessionId', session, 'ownerId', op.ownerId, 'epoch', epoch, 'expiresAt', now + op.ttlMs)
  -- Never expire the epoch counter during the room lifetime (ABA protection).
  local metaTtl = redis.call('PTTL', META)
  if metaTtl > 0 then redis.call('PEXPIRE', LEASE, metaTtl) else redis.call('PERSIST', LEASE) end
  if op.kind == 'renewLease' then return cjson.encode({result=true}) end
  return cjson.encode({result={ownerId=op.ownerId, epoch=epoch, expiresAt=now + op.ttlMs}})
end

if not rawCore then return err('ROOM_NOT_FOUND') end
local core = cjson.decode(rawCore)
if core.sessionId ~= session then return err('ROOM_NOT_FOUND') end
-- Writes the core back after a change (revision always; public revision when `public`).
local function saveCore(public)
  core.revision = core.revision + 1
  if public then core.publicRevision = core.revision end
  redis.call('HSET', META, 'core', cjson.encode(core))
end

-- Finalization maintenance stays available after logical gameplay expiry.
if op.kind == 'freezeReport' then
  if core.revision ~= op.expectedRevision or redis.call('EXISTS', REPORT) == 1 then return cjson.encode({result='RETRY'}) end
  if core.phase ~= 'PODIUM' and core.phase ~= 'FINISHED' then return err('INVALID_PHASE') end
  if op.report.session.id ~= session or op.report.session.hostId ~= core.hostId or op.report.session.pinCode ~= core.pinCode then
    return err('INVALID_REFERENCE')
  end
  redis.call('SET', REPORT, cjson.encode(op.report))
  saveCore(false)
  -- The frozen report and the room it describes outlive the safety TTL until durable and released.
  local keep = {META, KEYS[2], LEASE, PLAYERS, COMMANDS, TICKETS, REPORT}
  local quiz = cjson.decode(redis.call('HGET', META, 'quiz'))
  for q = 0, #quiz.questions - 1 do
    table.insert(keep, answersKey(q)); table.insert(keep, closedKey(q)); table.insert(keep, resultKey(q))
  end
  for _, key in ipairs(keep) do redis.call('PERSIST', key) end
  return cjson.encode({result='COMMITTED'})
elseif op.kind == 'acknowledgeDurableReport' then
  if redis.call('EXISTS', REPORT) == 0 then return err('INVALID_PHASE') end
  redis.call('HSET', META, 'durable', '1'); return cjson.encode({result=true})
elseif op.kind == 'markFinalization' then
  local status = op.status
  if status.sessionId ~= session then return err('INVALID_REFERENCE') end
  if redis.call('EXISTS', REPORT) == 0 or (status.status == 'ready' and redis.call('HGET', META, 'durable') ~= '1') then
    return err('FINALIZATION_PENDING')
  end
  if core.finalization ~= cjson.null and core.finalization.status == 'ready' and status.status ~= 'ready' then
    return err('INVALID_PHASE')
  end
  core.finalization = status
  saveCore(true)
  return cjson.encode({revision=core.revision})
elseif op.kind == 'expireToPodium' then
  -- Hard-lifetime end of a started game outside ANSWERING (code review MJ-06): PODIUM with
  -- endReason EXPIRED and a pending finalization, so the played questions still get a report.
  if core.phaseVersion ~= op.expectedPhaseVersion then return cjson.encode({result=false}) end
  if (core.phase ~= 'GAME_START_COUNTDOWN' and core.phase ~= 'QUESTION_PREVIEW' and core.phase ~= 'ANSWER_REVEAL'
    and core.phase ~= 'LEADERBOARD') or now < core.hardExpiresAt then
    return err('INVALID_PHASE')
  end
  core.phase = 'PODIUM'; core.phaseVersion = core.phaseVersion + 1; core.accepting = false
  core.timing = {phaseStartedAt=now, phaseEndsAt=now + 8000, questionStartedAt=cjson.null,
    inputClosesAt=cjson.null, acceptanceClosesAt=cjson.null}
  core.endReason = 'EXPIRED'
  core.finalization = {sessionId=session, status='pending', reportId=cjson.null, retryable=true,
    errorCode=cjson.null, updatedAt=now}
  saveCore(true)
  return cjson.encode({result=true})
end
return err('INVALID_FORMAT')
