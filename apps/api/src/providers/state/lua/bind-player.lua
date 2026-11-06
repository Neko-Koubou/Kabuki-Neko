-- Same three keys and session-scoped JSON protocol as mutate-room.lua.
local session, op = ARGV[1], cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 3 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease' then return err('INVALID_REFERENCE') end
for _, key in ipairs(KEYS) do
  local owner = redis.call('HGET', key, 'sessionId')
  if owner and owner ~= session then return err('ROOM_NOT_FOUND') end
end
local raw = redis.call('HGET', KEYS[1], 'state')
if not raw then return err('ROOM_NOT_FOUND') end
local s = cjson.decode(raw)
if s.sessionId ~= session then return err('ROOM_NOT_FOUND') end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
local expired = now >= tonumber(redis.call('HGET', KEYS[1], 'expiresAt')) or now >= s.hardExpiresAt or (s.phase == 'LOBBY' and now >= s.lobbyActiveAt + 7200000)
if s.phase == 'FINISHED' then expired = now >= s.timing.phaseStartedAt + 3600000 end
if expired then return err('ROOM_EXPIRED') end
local p, token, receipt = nil, cjson.null, nil
if op.kind == 'recover' then
  p = s.players[op.playerId]
  if not p or p.tokenHash ~= op.tokenHash then return err('INVALID_SESSION_TOKEN') end
elseif op.kind == 'join' then
  local prior = redis.call('HGET', KEYS[2], op.requestId)
  if prior then
    prior = cjson.decode(prior)
    if prior.expiresAt > now then
      if prior.payloadHash ~= op.payloadHash then return err('IDEMPOTENCY_CONFLICT') end
      p = s.players[prior.playerId]; token = prior.sessionToken
      if not p then return err('INVALID_SESSION_TOKEN') end
    end
  end
  if not p then
    if s.phase ~= 'LOBBY' then return err('GAME_IN_PROGRESS') end
    if s.isLocked then return err('ROOM_LOCKED') end
    local count = 0
    for _, existing in pairs(s.players) do
      count = count + 1
      if existing.nicknameKey == op.player.nicknameKey or existing.id == op.player.id then return err('NICKNAME_TAKEN') end
    end
    if count >= s.maxPlayers then return err('ROOM_FULL') end
    if s.reservations.baseBytes + (count + 1) * s.reservations.perPlayerBytes > 67108864 then return err('CAPACITY_REACHED') end
    p = op.player
    if s.friendlyNicknames then
      local ticket = s.tickets[op.friendlyTicketHash]
      if not ticket or ticket.consumed or ticket.expiresAt <= now or ticket.socketId ~= op.connectionId or ticket.nickname ~= p.nickname then return err('NICKNAME_INVALID') end
      ticket.consumed = true
    end
    p.joinOrder = count; p.joinedAt = now; p.kickedAt = cjson.null; p.connectionGeneration = 0
    p.score=0; p.streak=0; p.maxStreak=0; p.correctCount=0; p.responseSumMs=0; p.responseCount=0; p.rank=cjson.null; p.previousRank=cjson.null
    token = op.sessionToken
    receipt = {requestId=op.requestId,payloadHash=op.payloadHash,playerId=p.id,sessionToken=token,expiresAt=now+120000}
    s.players[p.id] = p
  end
else return err('INVALID_FORMAT') end
if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
p.connectionGeneration = p.connectionGeneration + 1; p.connectionId = op.connectionId
p.connected = true; p.lastSeenAt = now
if s.phase == 'LOBBY' then s.lobbyActiveAt = now end
s.revision = s.revision + 1; s.publicRevision = s.revision
-- All validation finishes before the first Redis write. Sidecar expires at most
-- 120s after its newest receipt; each older receipt retains its own logical TTL.
redis.call('HSET', KEYS[1], 'state', cjson.encode(s))
if receipt then
  redis.call('HSET', KEYS[2], 'sessionId', session, op.requestId, cjson.encode(receipt))
  redis.call('PEXPIRE', KEYS[2], 120000)
end
return cjson.encode({player=p,token=token,generation=p.connectionGeneration,revision=s.revision})
