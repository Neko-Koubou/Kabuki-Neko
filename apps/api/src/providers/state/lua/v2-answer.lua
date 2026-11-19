-- Redis room layout v2 (ADR-13, SA §6.1.1): answer admission and question freeze (TASK-185O).
--
-- Same seven declared KEYS and ARGV protocol as v2-room.lua:
--   1 :meta  2 :join-receipts  3 :lease  4 :players  5 :commands  6 :tickets  7 :report
-- The current question's :answers:<q> (hash playerId -> StoredAnswer) and :closed:<q> (string
-- ClosedQuestion) are built from the validated prefix, in the same {PIN} slot.
-- Operations:
--   admit: one answer (layout-v1 guards and error codes). On the last required answer
--          the question is frozen in the same script (ALL_ANSWERED).
--   close: freezes the current question for TIMER, HOST_SKIP, HOST_END, ALL_ANSWERED or EXPIRED
--          (layout-v1 `close` semantics).
--   hostCommand: host:skip_timer / host:end_game (TASK-185P). During ANSWERING they freeze the
--          question and park the command in meta `pendingCommand` (OPERATION_PENDING); the result
--          commit in v2-question.lua writes its ACK. Outside ANSWERING end_game goes to PODIUM.
-- Each operation decodes only `core`, one player and the current question's answers: its cost does
-- not grow with the number of played questions. `answeredRequired` in the core counts required
-- players that answered the current question, so an admission never scans the answers hash.
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

-- Keys of one question (same slot as every declared key).
local function answersKey(q) return prefix .. ':answers:' .. q end
local function closedKey(q) return prefix .. ':closed:' .. q end
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
-- SHA-256 over the immutable encoded freeze, bounded by the room capacity.
-- Local pure Lua/bit implementation; Redis exposes only SHA-1 natively.
local function sha256(message)
  local k = {1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298}
  local h = {1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225}
  local function add(...) local sum=0; for _,v in ipairs({...}) do sum=sum+v end; return bit.tobit(sum) end
  local length = #message * 8
  local high = math.floor(length / 4294967296)
  local low = length % 4294967296
  local function bytes(n) return string.char(bit.band(bit.rshift(n,24),255),bit.band(bit.rshift(n,16),255),bit.band(bit.rshift(n,8),255),bit.band(n,255)) end
  message = message .. string.char(128) .. string.rep(string.char(0),(55-#message)%64) .. bytes(high) .. bytes(low)
  for offset=1,#message,64 do
    local w={}
    for i=0,15 do local a,b,c,d=string.byte(message,offset+i*4,offset+i*4+3); w[i]=bit.bor(bit.lshift(a,24),bit.lshift(b,16),bit.lshift(c,8),d) end
    for i=16,63 do
      local x,y=w[i-15],w[i-2]
      local s0=bit.bxor(bit.ror(x,7),bit.ror(x,18),bit.rshift(x,3))
      local s1=bit.bxor(bit.ror(y,17),bit.ror(y,19),bit.rshift(y,10))
      w[i]=add(w[i-16],s0,w[i-7],s1)
    end
    local a,b,c,d,e,f,g,j=unpack(h)
    for i=0,63 do
      local s1=bit.bxor(bit.ror(e,6),bit.ror(e,11),bit.ror(e,25))
      local choose=bit.bxor(bit.band(e,f),bit.band(bit.bnot(e),g))
      local t1=add(j,s1,choose,k[i+1],w[i])
      local s0=bit.bxor(bit.ror(a,2),bit.ror(a,13),bit.ror(a,22))
      local majority=bit.bxor(bit.band(a,b),bit.band(a,c),bit.band(b,c))
      local t2=add(s0,majority)
      j=g; g=f; f=e; e=add(d,t1); d=c; c=b; b=a; a=add(t1,t2)
    end
    local out={a,b,c,d,e,f,g,j}; for i=1,8 do h[i]=add(h[i],out[i]) end
  end
  local out={}; for i=1,8 do out[i]=bit.tohex(h[i]) end; return table.concat(out)
end
-- Freezes the current question: every stored answer (sorted by player id), the required and
-- eligible sets and a SHA-256 over the encoded record, written once to :closed:<q>.
-- The record and its hash are built exactly as layout v1 built them.
local function freeze(reason)
  local q = tostring(core.questionIndex)
  local answers = {}
  local stored = redis.call('HGETALL', answersKey(q))
  for i = 2, #stored, 2 do table.insert(answers, cjson.decode(stored[i])) end
  table.sort(answers, function(a, b) return a.playerId < b.playerId end)
  local closed = {questionIndex=core.questionIndex, phaseVersion=core.phaseVersion, closedAt=now, reason=reason,
    requiredPlayerIds=core.requiredPlayerIds, eligiblePlayerIds=core.eligiblePlayerIds, answers=answers}
  closed.hash = sha256(cjson.encode(closed))
  redis.call('SET', closedKey(q), cjson.encode(closed)); followTtl(closedKey(q))
  core.accepting = false
  return closed
end

if op.kind == 'admit' then
  if expired then return err('ROOM_EXPIRED') end
  local rawPlayer = redis.call('HGET', PLAYERS, op.playerId)
  if not rawPlayer then return err('INVALID_SESSION_TOKEN') end
  local p = cjson.decode(rawPlayer)
  if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
  if p.connectionGeneration ~= op.generation then return err('SESSION_REPLACED') end
  -- The adapter resolves the question from this session's immutable quiz (the session check
  -- above binds it) and validates the answer with the shared schema; the structural checks below
  -- repeat the v1 script's defence in depth without decoding the whole quiz.
  local question = op.question
  if type(question) ~= 'table' or question.id ~= op.questionId then return err('QUESTION_MISMATCH') end
  local answer = op.answer
  if question.type == 'TYPE_ANSWER' then
    if type(answer) ~= 'string' or #answer == 0 or #answer > 32000 then return err('INVALID_ANSWER') end
  elseif question.type == 'ORDER_PUZZLE' or question.type == 'MULTIPLE_SELECT' then
    if type(answer) ~= 'table' or #answer < 1 or #answer > 4 or (question.type == 'ORDER_PUZZLE' and #answer ~= 4) then return err('INVALID_ANSWER') end
    local seen = {}
    for _, v in ipairs(answer) do
      if type(v) ~= 'number' or v % 1 ~= 0 or v < 0 or v >= question.optionCount or seen[v] then return err('INVALID_ANSWER') end
      seen[v] = true
    end
    if question.type == 'MULTIPLE_SELECT' then table.sort(answer) end
  else
    if type(answer) ~= 'number' or answer % 1 ~= 0 or answer < 0 or answer >= question.optionCount then return err('INVALID_ANSWER') end
  end
  local payloadHash = sha256(cjson.encode(answer))
  local q = tostring(op.questionIndex)
  -- Replays (same submission and payload) return the stored answer, even after the freeze.
  local prior = redis.call('HGET', answersKey(q), op.playerId)
  if prior then
    prior = cjson.decode(prior)
    if prior.submissionId == op.submissionId and prior.payloadHash == payloadHash then return cjson.encode({answer=prior}) end
    return err('ALREADY_ANSWERED')
  end
  if core.questionIndex ~= op.questionIndex then return err('QUESTION_MISMATCH') end
  if core.phase ~= 'QUESTION_ANSWERING' or not core.accepting then return err('INVALID_PHASE') end
  -- Inclusive deadline on the Redis clock.
  if core.timing.acceptanceClosesAt == cjson.null or now > core.timing.acceptanceClosesAt then return err('TIME_EXPIRED') end
  local accepted = {playerId=op.playerId, submissionId=op.submissionId, questionIndex=op.questionIndex,
    questionId=op.questionId, answer=answer, payloadHash=payloadHash, receivedAt=now,
    responseTimeMs=math.max(0, now - core.timing.questionStartedAt)}
  redis.call('HSET', answersKey(q), op.playerId, cjson.encode(accepted)); followTtl(answersKey(q))
  local eligible = false
  for _, id in ipairs(core.eligiblePlayerIds) do if id == op.playerId then eligible = true end end
  if not eligible then table.insert(core.eligiblePlayerIds, op.playerId) end
  for _, id in ipairs(core.requiredPlayerIds) do
    if id == op.playerId then core.answeredRequired = core.answeredRequired + 1 end
  end
  if #core.requiredPlayerIds > 0 and core.answeredRequired >= #core.requiredPlayerIds then freeze('ALL_ANSWERED') end
  saveCore(true)
  return cjson.encode({answer=accepted, revision=core.revision, frozen=not core.accepting})
end

-- Host skip/end use the same atomic freeze and persist their pending receipt.
-- The API waits/reconciles this receipt; an interim freeze is never a success ACK.
if op.kind == 'hostCommand' then
  if expired then return err('ROOM_EXPIRED') end
  if op.hostId ~= core.hostId then return err('FORBIDDEN') end
  local previous = redis.call('HGET', COMMANDS, op.requestId)
  if previous then
    previous = cjson.decode(previous)
    if previous.actorId ~= op.hostId or previous.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
    return cjson.encode({committed=false, revision=core.revision, phaseVersion=core.phaseVersion, ack=previous.ack})
  end
  local pending = redis.call('HGET', META, 'pendingCommand')
  if pending then
    pending = cjson.decode(pending)
    if pending.requestId == op.requestId and pending.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
    return err('OPERATION_PENDING')
  end
  if op.expectedPhaseVersion ~= core.phaseVersion then return err('STALE_PHASE') end
  if op.event ~= 'host:skip_timer' and op.event ~= 'host:end_game' then return err('INVALID_FORMAT') end
  if core.phase == 'QUESTION_ANSWERING' then
    if not core.accepting then return err('OPERATION_PENDING') end
    freeze(op.event == 'host:end_game' and 'HOST_END' or 'HOST_SKIP')
    saveCore(false); redis.call('HSET', META, 'pendingCommand', cjson.encode(op))
    return err('OPERATION_PENDING')
  end
  if op.event == 'host:skip_timer' then return err('INVALID_PHASE') end
  if core.phase ~= 'PODIUM' and core.phase ~= 'FINISHED' then
    core.phase = 'PODIUM'; core.phaseVersion = core.phaseVersion + 1; core.accepting = false; core.endReason = 'HOST_ENDED'
    core.timing = {phaseStartedAt=now, phaseEndsAt=now + 8000, questionStartedAt=cjson.null, inputClosesAt=cjson.null, acceptanceClosesAt=cjson.null}
    core.finalization = {sessionId=session, status='pending', reportId=cjson.null, retryable=true, errorCode=cjson.null, updatedAt=now}
  end
  local data = {phase='PODIUM', phaseVersion=core.phaseVersion, finalization=core.finalization}
  local response = {ok=true, requestId=op.requestId, serverTime=now, data=data}
  redis.call('HSET', COMMANDS, op.requestId, cjson.encode({actorId=op.hostId, payloadHash=op.payloadHash, ack=response, createdAt=now}))
  followTtl(COMMANDS)
  saveCore(true)
  return cjson.encode({committed=true, revision=core.revision, phaseVersion=core.phaseVersion, ack=response})
end

if op.kind ~= 'close' then return err('INVALID_FORMAT') end
if expired and op.reason ~= 'EXPIRED' then return err('ROOM_EXPIRED') end
if core.phaseVersion ~= op.expectedPhaseVersion then return err('STALE_PHASE') end
if core.questionIndex ~= cjson.null and redis.call('EXISTS', closedKey(tostring(core.questionIndex))) == 1 then
  return cjson.encode({result='ALREADY_CLOSED'})
end
if core.phase ~= 'QUESTION_ANSWERING' or core.questionIndex == cjson.null then return err('INVALID_PHASE') end
if op.reason == 'TIMER' then
  if core.timing.acceptanceClosesAt == cjson.null or now <= core.timing.acceptanceClosesAt then return err('TIME_EXPIRED') end
elseif op.reason == 'ALL_ANSWERED' then
  -- Checked against the answers themselves (not the counter), as in v1.
  if #core.requiredPlayerIds == 0 then return err('INVALID_PHASE') end
  local key = answersKey(tostring(core.questionIndex))
  for _, id in ipairs(core.requiredPlayerIds) do
    if redis.call('HEXISTS', key, id) == 0 then return err('INVALID_PHASE') end
  end
elseif op.reason == 'EXPIRED' then
  if not expired then return err('INVALID_PHASE') end
elseif op.reason ~= 'HOST_SKIP' and op.reason ~= 'HOST_END' then return err('INVALID_FORMAT') end
local frozen = freeze(op.reason)
saveCore(false)
return cjson.encode({closed=frozen, revision=core.revision})
