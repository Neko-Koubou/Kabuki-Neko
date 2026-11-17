-- KEYS: room:{PIN}:meta, room:{PIN}:join-receipts, room:{PIN}:lease.
-- ARGV: sessionId, JSON operation. Private state JSON is stored in meta.state.
-- Redis cjson represents empty collections as {}; the typed adapter restores
-- schema-declared arrays before validation. No arbitrary client patch is accepted.
local session = ARGV[1]
local op = cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 3 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease' then return err('INVALID_REFERENCE') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
for _, key in ipairs(KEYS) do
  local owner = redis.call('HGET', key, 'sessionId')
  if owner and owner ~= session then return err('ROOM_NOT_FOUND') end
end
if op.kind == 'create' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return cjson.encode({result='EXISTS'}) end
  local s = op.state
  if s.sessionId ~= session or prefix:sub(-7,-2) ~= s.pinCode or type(op.ttlMs) ~= 'number' or op.ttlMs <= 0 then return err('INVALID_REFERENCE') end
  local expiry = math.min(now + op.ttlMs, s.hardExpiresAt)
  redis.call('HSET', KEYS[1], 'sessionId', session, 'state', cjson.encode(s), 'expiresAt', expiry, 'durable', '0')
  -- Physical TTL is a safety horizon; logical expiry is checked per operation.
  redis.call('PEXPIREAT', KEYS[1], expiry + 86400000)
  return cjson.encode({result='CREATED'})
end
local raw = redis.call('HGET', KEYS[1], 'state')
if not raw then return err('ROOM_NOT_FOUND') end
local s = cjson.decode(raw)
if s.sessionId ~= session then return err('ROOM_NOT_FOUND') end
local expired = now >= tonumber(redis.call('HGET', KEYS[1], 'expiresAt')) or now >= s.hardExpiresAt or (s.phase == 'LOBBY' and now >= s.lobbyActiveAt + 7200000)
if s.phase == 'FINISHED' then expired = now >= s.timing.phaseStartedAt + 3600000 end
-- Finalization maintenance remains available after logical gameplay expiry.
if op.kind == 'freezeReport' then
  if s.revision ~= op.expectedRevision or s.frozenReport ~= cjson.null then return cjson.encode({result='RETRY'}) end
  if s.phase ~= 'PODIUM' and s.phase ~= 'FINISHED' then return err('INVALID_PHASE') end
  if op.report.session.id ~= session or op.report.session.hostId ~= s.hostId or op.report.session.pinCode ~= s.pinCode then return err('INVALID_REFERENCE') end
  s.frozenReport=op.report; s.revision=s.revision+1
  redis.call('HSET',KEYS[1],'state',cjson.encode(s)); redis.call('PERSIST',KEYS[1]); redis.call('PERSIST',KEYS[3])
  return cjson.encode({result='COMMITTED'})
elseif op.kind == 'acknowledgeDurableReport' then
  if s.frozenReport == cjson.null then return err('INVALID_PHASE') end
  redis.call('HSET',KEYS[1],'durable','1'); return cjson.encode({result=true})
elseif op.kind == 'markFinalization' then
  local status=op.status
  if status.sessionId ~= session then return err('INVALID_REFERENCE') end
  if s.frozenReport == cjson.null or (status.status == 'ready' and redis.call('HGET',KEYS[1],'durable') ~= '1') then return err('FINALIZATION_PENDING') end
  if s.finalization ~= cjson.null and s.finalization.status == 'ready' and status.status ~= 'ready' then return err('INVALID_PHASE') end
  s.finalization=status; s.revision=s.revision+1; s.publicRevision=s.revision
  redis.call('HSET',KEYS[1],'state',cjson.encode(s))
  return cjson.encode({revision=s.revision})
elseif op.kind == 'expireToPodium' then
  -- Hard-lifetime end of a started game outside ANSWERING (code review MJ-06): PODIUM with
  -- endReason EXPIRED and a pending finalization, so the played questions still get a report.
  if s.phaseVersion ~= op.expectedPhaseVersion then return cjson.encode({result=false}) end
  if (s.phase ~= 'GAME_START_COUNTDOWN' and s.phase ~= 'QUESTION_PREVIEW' and s.phase ~= 'ANSWER_REVEAL' and s.phase ~= 'LEADERBOARD') or now < s.hardExpiresAt then return err('INVALID_PHASE') end
  s.phase='PODIUM'; s.phaseVersion=s.phaseVersion+1; s.accepting=false
  s.timing={phaseStartedAt=now,phaseEndsAt=now+8000,questionStartedAt=cjson.null,inputClosesAt=cjson.null,acceptanceClosesAt=cjson.null}
  s.endReason='EXPIRED'
  s.finalization={sessionId=session,status='pending',reportId=cjson.null,retryable=true,errorCode=cjson.null,updatedAt=now}
  s.revision=s.revision+1; s.publicRevision=s.revision
  redis.call('HSET',KEYS[1],'state',cjson.encode(s))
  return cjson.encode({result=true})
end
if expired then return err('ROOM_EXPIRED') end
local function write(public)
  s.revision = s.revision + 1
  if public then s.publicRevision = s.revision end
  redis.call('HSET', KEYS[1], 'state', cjson.encode(s))
end
local function phase(name, duration)
  s.phase = name; s.phaseVersion = s.phaseVersion + 1; s.accepting = false
  s.timing = {phaseStartedAt=now, phaseEndsAt=duration and now+duration or cjson.null,
    questionStartedAt=cjson.null, inputClosesAt=cjson.null, acceptanceClosesAt=cjson.null}
end
if op.kind == 'presence' then
  local p = s.players[op.playerId]
  if not p or p.kickedAt ~= cjson.null or p.connectionGeneration ~= op.generation then return cjson.encode({result=false}) end
  p.connected = op.connected; p.lastSeenAt = now
  if not op.connected then p.connectionId = cjson.null end
  write(true); return cjson.encode({result=true, revision=s.revision})
end
if op.kind == 'avatar' then
  local p = s.players[op.playerId]
  if not p then return err('INVALID_SESSION_TOKEN') end
  if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
  if p.connectionGeneration ~= op.generation then return err('SESSION_REPLACED') end
  if s.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  p.avatar = {style=op.avatar.style, seed=op.avatar.seed}
  s.lobbyActiveAt = now
  write(true); return cjson.encode({result=true, revision=s.revision})
end
if op.kind == 'ticket' then
  if s.phase ~= 'LOBBY' then return err('GAME_IN_PROGRESS') end
  if s.isLocked then return err('ROOM_LOCKED') end
  local t = op.ticket
  if t.consumed or t.expiresAt <= now or t.expiresAt > now + 120000 then return err('NICKNAME_INVALID') end
  for _, p in pairs(s.players) do if p.nickname == t.nickname then return err('NICKNAME_TAKEN') end end
  for _, previous in pairs(s.tickets) do
    if previous.socketId ~= t.socketId and previous.expiresAt > now and previous.nickname == t.nickname then return err('NICKNAME_TAKEN') end
  end
  for key, previous in pairs(s.tickets) do if previous.socketId == t.socketId or previous.expiresAt <= now then s.tickets[key] = nil end end
  s.tickets[t.tokenHash] = t; write(false); return cjson.encode({result=true})
end
if op.kind == 'transition' then
  if s.phaseVersion ~= op.expectedPhaseVersion then return cjson.encode({result=false}) end
  if s.timing.phaseEndsAt == cjson.null or now < s.timing.phaseEndsAt then return cjson.encode({result=false}) end
  if s.phase == 'GAME_START_COUNTDOWN' and op.phase == 'QUESTION_PREVIEW' and op.questionIndex == 0 then
    s.questionIndex = 0; phase('QUESTION_PREVIEW', 4000)
  elseif s.phase == 'QUESTION_PREVIEW' and op.phase == 'QUESTION_ANSWERING' and op.questionIndex == s.questionIndex then
    local q = s.quiz.questions[s.questionIndex + 1]
    if not q then return err('QUESTION_MISMATCH') end
    phase('QUESTION_ANSWERING', q.timeLimitSec * 1000)
    s.accepting = true; s.timing.questionStartedAt = now
    s.timing.inputClosesAt = now + q.timeLimitSec * 1000
    s.timing.acceptanceClosesAt = s.timing.inputClosesAt + 1500
    s.requiredPlayerIds = {}; s.eligiblePlayerIds = {}
    for id, p in pairs(s.players) do
      if p.connected and p.kickedAt == cjson.null then table.insert(s.requiredPlayerIds, id); table.insert(s.eligiblePlayerIds, id) end
    end
  elseif s.phase == 'PODIUM' and op.phase == 'FINISHED' and op.questionIndex == s.questionIndex then phase('FINISHED', nil)
  else return err('INVALID_PHASE') end
  write(true); return cjson.encode({result=true, phaseVersion=s.phaseVersion, timing=s.timing})
end
if op.kind ~= 'command' then return err('INVALID_FORMAT') end
if op.hostId ~= s.hostId then return err('FORBIDDEN') end
local receipt = s.commands[op.requestId]
if receipt then
  if receipt.actorId ~= op.hostId or receipt.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
  return cjson.encode({committed=false, revision=s.revision, phaseVersion=s.phaseVersion, ack=receipt.ack})
end
if s.phaseVersion ~= op.expectedPhaseVersion then return err('STALE_PHASE') end
if redis.call('HEXISTS',KEYS[1],'pendingCommand') == 1 then return err('OPERATION_PENDING') end
local data
if op.event == 'host:lock_room' then
  if s.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  if type(op.isLocked) ~= 'boolean' then return err('INVALID_FORMAT') end
  s.isLocked = op.isLocked; data = {isLocked=s.isLocked}
elseif op.event == 'host:kick_player' then
  if s.phase == 'PODIUM' or s.phase == 'FINISHED' then return err('INVALID_PHASE') end
  local p = s.players[op.playerId]
  if not p then return err('NOT_FOUND') end
  if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
  p.kickedAt = now; p.connected = false; p.connectionId = cjson.null; p.connectionGeneration = p.connectionGeneration + 1
  local q = s.questionIndex ~= cjson.null and tostring(s.questionIndex) or 'none'
  if not s.answers[q .. ':' .. op.playerId] and not s.closedQuestions[q] then
    for _, field in ipairs({'requiredPlayerIds','eligiblePlayerIds'}) do
      local remaining = {}; for _, id in ipairs(s[field]) do if id ~= op.playerId then table.insert(remaining, id) end end
      s[field] = remaining
    end
  end
  data = {kicked=true, playerId=op.playerId}
elseif op.event == 'host:start_game' then
  if s.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  local connected = false
  for _, p in pairs(s.players) do if p.connected and p.kickedAt == cjson.null then connected = true end end
  if not connected then return err('NO_PLAYERS') end
  s.isLocked = true; phase('GAME_START_COUNTDOWN', 3000)
  data = {phase=s.phase, phaseVersion=s.phaseVersion}
elseif op.event == 'host:next_step' then
  if s.phase == 'ANSWER_REVEAL' and s.questionIndex < #s.quiz.questions - 1 then phase('LEADERBOARD', nil)
  elseif s.phase == 'LEADERBOARD' and s.questionIndex < #s.quiz.questions - 1 then
    s.questionIndex = s.questionIndex + 1; phase('QUESTION_PREVIEW', 4000)
  elseif s.phase == 'ANSWER_REVEAL' then
    phase('PODIUM', 8000); s.endReason = 'COMPLETED'
    s.finalization = {sessionId=session,status='pending',reportId=cjson.null,retryable=true,errorCode=cjson.null,updatedAt=now}
  else return err('INVALID_PHASE') end
  data = {phase=s.phase, phaseVersion=s.phaseVersion}
else return err('INVALID_PHASE') end
if s.phase == 'LOBBY' then s.lobbyActiveAt = now end
local ack = {ok=true,requestId=op.requestId,serverTime=now,data=data}
s.commands[op.requestId] = {actorId=op.hostId,payloadHash=op.payloadHash,ack=ack,createdAt=now}
write(true)
return cjson.encode({committed=true,revision=s.revision,phaseVersion=s.phaseVersion,ack=ack})
