-- Conditional room release and scheduler lease operations. Same ordered keys.
local session, op = ARGV[1], cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 3 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease' then return err('INVALID_REFERENCE') end
for _, key in ipairs(KEYS) do
  local owner = redis.call('HGET', key, 'sessionId')
  if owner and owner ~= session then return cjson.encode({result=false}) end
end
local raw = redis.call('HGET', KEYS[1], 'state')
if not raw then return cjson.encode({result=false}) end
local s = cjson.decode(raw)
if s.sessionId ~= session then return cjson.encode({result=false}) end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
if op.kind == 'releaseRoom' then
  if s.frozenReport ~= cjson.null and (redis.call('HGET',KEYS[1],'durable') ~= '1' or s.finalization == cjson.null or s.finalization.status ~= 'ready') then return cjson.encode({result=false}) end
  redis.call('DEL', unpack(KEYS)); return cjson.encode({result=true})
end
local owner = redis.call('HGET', KEYS[3], 'ownerId')
local epoch = tonumber(redis.call('HGET', KEYS[3], 'epoch') or '0')
local expiry = tonumber(redis.call('HGET', KEYS[3], 'expiresAt') or '0')
if op.kind == 'releaseLease' then
  if owner ~= op.ownerId or epoch ~= op.epoch then return cjson.encode({result=false}) end
  redis.call('HDEL', KEYS[3], 'ownerId'); redis.call('HSET', KEYS[3], 'expiresAt', 0)
  return cjson.encode({result=true})
end
if type(op.ttlMs) ~= 'number' or op.ttlMs <= 0 or op.ttlMs % 1 ~= 0 then return err('INVALID_FORMAT') end
if op.kind == 'acquireLease' then
  if owner and expiry > now then return cjson.encode({result=cjson.null}) end
  epoch = epoch + 1
elseif op.kind == 'renewLease' then
  if owner ~= op.ownerId or epoch ~= op.epoch or expiry <= now then return cjson.encode({result=false}) end
else return err('INVALID_FORMAT') end
redis.call('HSET', KEYS[3], 'sessionId',session,'ownerId',op.ownerId,'epoch',epoch,'expiresAt',now+op.ttlMs)
-- Never expire the epoch counter during the room lifetime (ABA protection).
local metaTTL = redis.call('PTTL', KEYS[1])
if metaTTL > 0 then redis.call('PEXPIRE', KEYS[3], metaTTL) else redis.call('PERSIST', KEYS[3]) end
if op.kind == 'renewLease' then return cjson.encode({result=true}) end
return cjson.encode({result={ownerId=op.ownerId,epoch=epoch,expiresAt=now+op.ttlMs}})
