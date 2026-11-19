-- Redis room layout v2 (ADR-13, SA §6.1.1): result commit, host commands and phases (TASK-185P).
--
-- Same seven declared KEYS and ARGV protocol as v2-room.lua:
--   1 :meta  2 :join-receipts  3 :lease  4 :players  5 :commands  6 :tickets  7 :report
-- The current question's :answers:<q>, :closed:<q> and :result:<q> are built from the validated
-- prefix, in the same {PIN} slot.
-- Operations (layout-v1 `command`/`transition` and `commit` semantics, same error
-- codes and ACK semantics):
--   command:    host:lock_room, host:kick_player, host:start_game, host:next_step, deduplicated by
--               requestId in :commands and fenced by expectedPhaseVersion;
--   transition: scheduled phase changes with a phaseVersion CAS on the Redis clock;
--   commit:     the scored result of the frozen current question (CAS on core.revision and the
--               closed hash); writes :result:<q>, the totals of every player, scoredQuestions and
--               the next phase, and the ACK of a host skip/end parked by v2-answer.lua.
-- The quiz is never decoded: the adapter passes the values it needs (question count, the current
-- question's id and time limit) from the session's immutable quiz, which the session check binds.
local session, op = ARGV[1], cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 7 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease'
  or KEYS[4] ~= prefix .. ':players' or KEYS[5] ~= prefix .. ':commands'
  or KEYS[6] ~= prefix .. ':tickets' or KEYS[7] ~= prefix .. ':report' then
  return err('INVALID_REFERENCE')
end
local META, PLAYERS, COMMANDS = KEYS[1], KEYS[4], KEYS[5]
for _, key in ipairs({META, KEYS[2], KEYS[3]}) do
  local owner = redis.call('HGET', key, 'sessionId')
  if owner and owner ~= session then return err('ROOM_NOT_FOUND') end
end
local rawCore = redis.call('HGET', META, 'core')
if not rawCore then return err('ROOM_NOT_FOUND') end
local core = cjson.decode(rawCore)
if core.sessionId ~= session then return err('ROOM_NOT_FOUND') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expired = now >= tonumber(redis.call('HGET', META, 'expiresAt')) or now >= core.hardExpiresAt
  or (core.phase == 'LOBBY' and now >= core.lobbyActiveAt + 7200000)
if core.phase == 'FINISHED' then expired = now >= core.timing.phaseStartedAt + 3600000 end

-- Keys of one question (same slot as every declared key).
local function answersKey(q) return prefix .. ':answers:' .. q end
local function closedKey(q) return prefix .. ':closed:' .. q end
local function resultKey(q) return prefix .. ':result:' .. q end
-- Copies the meta key's physical expiry onto `key` (persistent while meta is persistent).
local function followTtl(key)
  local at = redis.call('PEXPIRETIME', META)
  if at > 0 then redis.call('PEXPIREAT', key, at) else redis.call('PERSIST', key) end
end
-- Writes the core back after a change (revision always; public revision when `public`).
local function saveCore(public)
  core.revision = core.revision + 1
  if public then core.publicRevision = core.revision end
  redis.call('HSET', META, 'core', cjson.encode(core))
end
-- Enters phase `name` for `duration` ms (nil: no deadline) and closes answer intake.
local function phase(name, duration)
  core.phase = name; core.phaseVersion = core.phaseVersion + 1; core.accepting = false
  core.timing = {phaseStartedAt=now, phaseEndsAt=duration and now + duration or cjson.null,
    questionStartedAt=cjson.null, inputClosesAt=cjson.null, acceptanceClosesAt=cjson.null}
end
-- A pending finalization record for the game that just reached PODIUM.
local function pendingFinalization()
  return {sessionId=session, status='pending', reportId=cjson.null, retryable=true, errorCode=cjson.null, updatedAt=now}
end
-- Stores the success ACK of a host command as its idempotency receipt and returns the ACK.
local function ack(command, data)
  local response = {ok=true, requestId=command.requestId, serverTime=now, data=data}
  redis.call('HSET', COMMANDS, command.requestId,
    cjson.encode({actorId=command.hostId, payloadHash=command.payloadHash, ack=response, createdAt=now}))
  followTtl(COMMANDS)
  return response
end
-- Every stored player, decoded, keyed by id (one HGETALL: per question or command, never per answer).
local function allPlayers()
  local players, raw = {}, redis.call('HGETALL', PLAYERS)
  for i = 1, #raw, 2 do players[raw[i]] = cjson.decode(raw[i + 1]) end
  return players
end

if op.kind == 'commit' then
  local q = core.questionIndex ~= cjson.null and tostring(core.questionIndex) or 'none'
  local rawClosed = redis.call('GET', closedKey(q))
  if not rawClosed or core.accepting or core.phase ~= 'QUESTION_ANSWERING' or core.revision ~= op.expectedRevision
    or redis.call('EXISTS', resultKey(q)) == 1 then
    return cjson.encode({result='RETRY'})
  end
  local closed = cjson.decode(rawClosed)
  if closed.hash ~= op.closedQuestionHash then return cjson.encode({result='RETRY'}) end
  local result = op.result
  if result.questionIndex ~= core.questionIndex then return err('INVALID_REFERENCE') end
  -- The totals must cover exactly the room's players, each with every total field.
  local players = allPlayers()
  for id, _ in pairs(players) do if not result.playerTotals[id] then return err('INVALID_REFERENCE') end end
  local fields = {'score', 'streak', 'maxStreak', 'correctCount', 'responseSumMs', 'responseCount', 'rank', 'previousRank'}
  for id, totals in pairs(result.playerTotals) do
    if not players[id] then return err('INVALID_REFERENCE') end
    for _, field in ipairs(fields) do if totals[field] == nil then return err('INVALID_REFERENCE') end end
  end
  for id, totals in pairs(result.playerTotals) do
    local p = players[id]
    for _, field in ipairs(fields) do p[field] = totals[field] end
    redis.call('HSET', PLAYERS, id, cjson.encode(p))
  end
  followTtl(PLAYERS)
  redis.call('SET', resultKey(q), cjson.encode(result)); followTtl(resultKey(q))
  table.insert(core.scoredQuestions, core.questionIndex)
  local ended = closed.reason == 'HOST_END' or closed.reason == 'EXPIRED'
  core.phaseVersion = core.phaseVersion + 1
  core.phase = ended and 'PODIUM' or 'ANSWER_REVEAL'
  core.accepting = false
  core.timing = {phaseStartedAt=now, phaseEndsAt=ended and now + 8000 or cjson.null,
    questionStartedAt=cjson.null, inputClosesAt=cjson.null, acceptanceClosesAt=cjson.null}
  if ended then
    core.endReason = closed.reason == 'EXPIRED' and 'EXPIRED' or 'HOST_ENDED'
    core.finalization = pendingFinalization()
  end
  -- A parked host skip/end gets its ACK with the committed phase.
  local pending = redis.call('HGET', META, 'pendingCommand')
  if pending then
    pending = cjson.decode(pending)
    local data = {phase=core.phase, phaseVersion=core.phaseVersion}
    if pending.event == 'host:end_game' then data.phase = 'PODIUM'; data.finalization = core.finalization end
    ack(pending, data)
  end
  saveCore(true); redis.call('HDEL', META, 'pendingCommand')
  return cjson.encode({result='COMMITTED', revision=core.revision, phaseVersion=core.phaseVersion})
end

if expired then return err('ROOM_EXPIRED') end

if op.kind == 'transition' then
  if core.phaseVersion ~= op.expectedPhaseVersion then return cjson.encode({result=false}) end
  if core.timing.phaseEndsAt == cjson.null or now < core.timing.phaseEndsAt then return cjson.encode({result=false}) end
  if core.phase == 'GAME_START_COUNTDOWN' and op.phase == 'QUESTION_PREVIEW' and op.questionIndex == 0 then
    core.questionIndex = 0; phase('QUESTION_PREVIEW', 4000)
  elseif core.phase == 'QUESTION_PREVIEW' and op.phase == 'QUESTION_ANSWERING' and op.questionIndex == core.questionIndex then
    -- The adapter resolves the current question from the session's quiz.
    local question = op.question
    if type(question) ~= 'table' or question.index ~= core.questionIndex then return err('QUESTION_MISMATCH') end
    phase('QUESTION_ANSWERING', question.timeLimitSec * 1000)
    core.accepting = true; core.timing.questionStartedAt = now
    core.timing.inputClosesAt = now + question.timeLimitSec * 1000
    core.timing.acceptanceClosesAt = core.timing.inputClosesAt + 1500
    core.requiredPlayerIds = {}; core.eligiblePlayerIds = {}; core.answeredRequired = 0
    local raw = redis.call('HGETALL', PLAYERS)
    for i = 1, #raw, 2 do
      local p = cjson.decode(raw[i + 1])
      if p.connected and p.kickedAt == cjson.null then
        table.insert(core.requiredPlayerIds, raw[i]); table.insert(core.eligiblePlayerIds, raw[i])
      end
    end
  elseif core.phase == 'PODIUM' and op.phase == 'FINISHED' and op.questionIndex == core.questionIndex then
    phase('FINISHED', nil)
  else
    return err('INVALID_PHASE')
  end
  saveCore(true)
  return cjson.encode({result=true, phaseVersion=core.phaseVersion, timing=core.timing})
end

if op.kind ~= 'command' then return err('INVALID_FORMAT') end
if op.hostId ~= core.hostId then return err('FORBIDDEN') end
local receipt = redis.call('HGET', COMMANDS, op.requestId)
if receipt then
  receipt = cjson.decode(receipt)
  if receipt.actorId ~= op.hostId or receipt.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
  return cjson.encode({committed=false, revision=core.revision, phaseVersion=core.phaseVersion, ack=receipt.ack})
end
if core.phaseVersion ~= op.expectedPhaseVersion then return err('STALE_PHASE') end
if redis.call('HEXISTS', META, 'pendingCommand') == 1 then return err('OPERATION_PENDING') end
local data
if op.event == 'host:lock_room' then
  if core.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  if type(op.isLocked) ~= 'boolean' then return err('INVALID_FORMAT') end
  core.isLocked = op.isLocked; data = {isLocked=core.isLocked}
elseif op.event == 'host:kick_player' then
  if core.phase == 'PODIUM' or core.phase == 'FINISHED' then return err('INVALID_PHASE') end
  if type(op.playerId) ~= 'string' then return err('NOT_FOUND') end
  local raw = redis.call('HGET', PLAYERS, op.playerId)
  if not raw then return err('NOT_FOUND') end
  local p = cjson.decode(raw)
  if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
  p.kickedAt = now; p.connected = false; p.connectionId = cjson.null; p.connectionGeneration = p.connectionGeneration + 1
  redis.call('HSET', PLAYERS, op.playerId, cjson.encode(p))
  -- An unanswered player leaves the current question's required and eligible sets while it is
  -- open; answeredRequired counts answered players only, so it stays exact.
  if core.questionIndex ~= cjson.null then
    local q = tostring(core.questionIndex)
    if redis.call('HEXISTS', answersKey(q), op.playerId) == 0 and redis.call('EXISTS', closedKey(q)) == 0 then
      for _, field in ipairs({'requiredPlayerIds', 'eligiblePlayerIds'}) do
        local remaining = {}
        for _, id in ipairs(core[field]) do if id ~= op.playerId then table.insert(remaining, id) end end
        core[field] = remaining
      end
    end
  end
  data = {kicked=true, playerId=op.playerId}
elseif op.event == 'host:start_game' then
  if core.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  local connected = false
  for _, raw in ipairs(redis.call('HVALS', PLAYERS)) do
    local p = cjson.decode(raw)
    if p.connected and p.kickedAt == cjson.null then connected = true; break end
  end
  if not connected then return err('NO_PLAYERS') end
  core.isLocked = true; phase('GAME_START_COUNTDOWN', 3000)
  data = {phase=core.phase, phaseVersion=core.phaseVersion}
elseif op.event == 'host:next_step' then
  local last = type(op.questionCount) == 'number' and op.questionCount - 1 or -1
  if core.phase == 'ANSWER_REVEAL' and core.questionIndex < last then phase('LEADERBOARD', nil)
  elseif core.phase == 'LEADERBOARD' and core.questionIndex < last then
    core.questionIndex = core.questionIndex + 1; phase('QUESTION_PREVIEW', 4000)
  elseif core.phase == 'ANSWER_REVEAL' then
    phase('PODIUM', 8000); core.endReason = 'COMPLETED'; core.finalization = pendingFinalization()
  else
    return err('INVALID_PHASE')
  end
  data = {phase=core.phase, phaseVersion=core.phaseVersion}
else
  return err('INVALID_PHASE')
end
if core.phase == 'LOBBY' then core.lobbyActiveAt = now end
local response = ack(op, data)
saveCore(true)
return cjson.encode({committed=true, revision=core.revision, phaseVersion=core.phaseVersion, ack=response})
