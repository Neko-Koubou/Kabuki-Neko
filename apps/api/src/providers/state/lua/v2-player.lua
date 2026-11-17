-- Redis room layout v2 (ADR-13, SA §6.1.1): player operations (TASK-185N).
--
-- Same seven declared KEYS and ARGV protocol as v2-room.lua:
--   1 :meta  2 :join-receipts  3 :lease  4 :players  5 :commands  6 :tickets  7 :report
-- Operations: join (with a 120 s join receipt and friendly tickets), recover, presence, avatar and
-- ticket. Each one decodes only `core` and the player or ticket fields it touches, then writes
-- back only those fields: the cost depends on the room's players, never on played questions.
-- Semantics are those of the v1 scripts bind-player.lua and mutate-room.lua (same error codes).
local session, op = ARGV[1], cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 7 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease'
  or KEYS[4] ~= prefix .. ':players' or KEYS[5] ~= prefix .. ':commands'
  or KEYS[6] ~= prefix .. ':tickets' or KEYS[7] ~= prefix .. ':report' then
  return err('INVALID_REFERENCE')
end
local META, RECEIPTS, PLAYERS, TICKETS = KEYS[1], KEYS[2], KEYS[4], KEYS[6]
for _, key in ipairs({META, RECEIPTS, KEYS[3]}) do
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

-- Copies the meta key's physical expiry onto `key` (persistent while meta is persistent).
local function followTtl(key)
  local at = redis.call('PEXPIRETIME', META)
  if at > 0 then redis.call('PEXPIREAT', key, at) else redis.call('PERSIST', key) end
end
-- One stored player, decoded, or nil.
local function getPlayer(id)
  local raw = redis.call('HGET', PLAYERS, id)
  if not raw then return nil end
  return cjson.decode(raw)
end
-- Stores one player and aligns the players key's expiry.
local function putPlayer(p)
  redis.call('HSET', PLAYERS, p.id, cjson.encode(p)); followTtl(PLAYERS)
end
-- Writes the core back after a change (revision always; public revision when `public`).
local function saveCore(public)
  core.revision = core.revision + 1
  if public then core.publicRevision = core.revision end
  redis.call('HSET', META, 'core', cjson.encode(core))
end

if op.kind == 'presence' then
  if expired then return err('ROOM_EXPIRED') end
  local p = getPlayer(op.playerId)
  if not p or p.kickedAt ~= cjson.null or p.connectionGeneration ~= op.generation then return cjson.encode({result=false}) end
  p.connected = op.connected; p.lastSeenAt = now
  if not op.connected then p.connectionId = cjson.null end
  putPlayer(p); saveCore(true)
  return cjson.encode({result=true, revision=core.revision})
end

if op.kind == 'avatar' then
  if expired then return err('ROOM_EXPIRED') end
  local p = getPlayer(op.playerId)
  if not p then return err('INVALID_SESSION_TOKEN') end
  if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
  if p.connectionGeneration ~= op.generation then return err('SESSION_REPLACED') end
  if core.phase ~= 'LOBBY' then return err('INVALID_PHASE') end
  p.avatar = {style=op.avatar.style, seed=op.avatar.seed}
  core.lobbyActiveAt = now
  putPlayer(p); saveCore(true)
  return cjson.encode({result=true, revision=core.revision})
end

if op.kind == 'ticket' then
  if expired then return err('ROOM_EXPIRED') end
  if core.phase ~= 'LOBBY' then return err('GAME_IN_PROGRESS') end
  if core.isLocked then return err('ROOM_LOCKED') end
  local t = op.ticket
  if t.consumed or t.expiresAt <= now or t.expiresAt > now + 120000 then return err('NICKNAME_INVALID') end
  for _, raw in ipairs(redis.call('HVALS', PLAYERS)) do
    if cjson.decode(raw).nickname == t.nickname then return err('NICKNAME_TAKEN') end
  end
  local stored = redis.call('HGETALL', TICKETS)
  for i = 1, #stored, 2 do
    local previous = cjson.decode(stored[i + 1])
    if previous.socketId ~= t.socketId and previous.expiresAt > now and previous.nickname == t.nickname then return err('NICKNAME_TAKEN') end
  end
  -- Drop this socket's earlier ticket and every expired one.
  for i = 1, #stored, 2 do
    local previous = cjson.decode(stored[i + 1])
    if previous.socketId == t.socketId or previous.expiresAt <= now then redis.call('HDEL', TICKETS, stored[i]) end
  end
  redis.call('HSET', TICKETS, t.tokenHash, cjson.encode(t)); followTtl(TICKETS)
  saveCore(false)
  return cjson.encode({result=true})
end

-- join / recover: bind a connection to a player slot.
if expired then return err('ROOM_EXPIRED') end
local p, token, receipt, consumedTicket = nil, cjson.null, nil, nil
if op.kind == 'recover' then
  p = getPlayer(op.playerId)
  if not p or p.tokenHash ~= op.tokenHash then return err('INVALID_SESSION_TOKEN') end
elseif op.kind == 'join' then
  local prior = redis.call('HGET', RECEIPTS, op.requestId)
  if prior then
    prior = cjson.decode(prior)
    if prior.expiresAt > now then
      if prior.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
      p = getPlayer(prior.playerId); token = prior.sessionToken
      if not p then return err('INVALID_SESSION_TOKEN') end
    end
  end
  if not p then
    if core.phase ~= 'LOBBY' then return err('GAME_IN_PROGRESS') end
    if core.isLocked then return err('ROOM_LOCKED') end
    local count = 0
    for _, raw in ipairs(redis.call('HVALS', PLAYERS)) do
      count = count + 1
      local existing = cjson.decode(raw)
      if existing.nicknameKey == op.player.nicknameKey or existing.id == op.player.id then return err('NICKNAME_TAKEN') end
    end
    if count >= core.maxPlayers then return err('ROOM_FULL') end
    if core.reservations.baseBytes + (count + 1) * core.reservations.perPlayerBytes > 67108864 then return err('CAPACITY_REACHED') end
    p = op.player
    if core.friendlyNicknames then
      -- A missing ticket hash arrives as cjson.null (not a string): no ticket, no join.
      if type(op.friendlyTicketHash) ~= 'string' then return err('NICKNAME_INVALID') end
      local rawTicket = redis.call('HGET', TICKETS, op.friendlyTicketHash)
      local ticket = rawTicket and cjson.decode(rawTicket)
      if not ticket or ticket.consumed or ticket.expiresAt <= now or ticket.socketId ~= op.connectionId or ticket.nickname ~= p.nickname then
        return err('NICKNAME_INVALID')
      end
      ticket.consumed = true; consumedTicket = ticket
    end
    p.joinOrder = count; p.joinedAt = now; p.kickedAt = cjson.null; p.connectionGeneration = 0
    p.score = 0; p.streak = 0; p.maxStreak = 0; p.correctCount = 0; p.responseSumMs = 0; p.responseCount = 0
    p.rank = cjson.null; p.previousRank = cjson.null
    token = op.sessionToken
    receipt = {requestId=op.requestId, payloadHash=op.payloadHash, playerId=p.id, sessionToken=token, expiresAt=now + 120000}
  end
else
  return err('INVALID_FORMAT')
end
if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
p.connectionGeneration = p.connectionGeneration + 1; p.connectionId = op.connectionId
p.connected = true; p.lastSeenAt = now
if core.phase == 'LOBBY' then core.lobbyActiveAt = now end
-- All validation finishes before the first write.
putPlayer(p)
if consumedTicket then redis.call('HSET', TICKETS, op.friendlyTicketHash, cjson.encode(consumedTicket)) end
saveCore(true)
-- The receipt sidecar expires at most 120 s after its newest receipt; each older receipt keeps
-- its own logical expiry.
if receipt then
  redis.call('HSET', RECEIPTS, 'sessionId', session, op.requestId, cjson.encode(receipt))
  redis.call('PEXPIRE', RECEIPTS, 120000)
end
return cjson.encode({player=p, token=token, generation=p.connectionGeneration, revision=core.revision})
