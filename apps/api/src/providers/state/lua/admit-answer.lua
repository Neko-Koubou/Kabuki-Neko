-- Same-slot private room protocol; all timestamps come from Redis TIME.
local session, op = ARGV[1], cjson.decode(ARGV[2])
local function err(code) return cjson.encode({error=code}) end
local prefix = string.match(KEYS[1], '^(.*{%d%d%d%d%d%d}):meta$')
if not prefix or #KEYS ~= 3 or KEYS[2] ~= prefix .. ':join-receipts' or KEYS[3] ~= prefix .. ':lease' then return err('INVALID_REFERENCE') end
for _, key in ipairs(KEYS) do
  local owner = redis.call('HGET',key,'sessionId')
  if owner and owner ~= session then return err('ROOM_NOT_FOUND') end
end
local raw = redis.call('HGET',KEYS[1],'state')
if not raw then return err('ROOM_NOT_FOUND') end
local s = cjson.decode(raw)
if s.sessionId ~= session then return err('ROOM_NOT_FOUND') end
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
local expired = now >= tonumber(redis.call('HGET',KEYS[1],'expiresAt')) or now >= s.hardExpiresAt
local function write(public)
  s.revision = s.revision + 1
  if public then s.publicRevision = s.revision end
  redis.call('HSET',KEYS[1],'state',cjson.encode(s))
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
local function freeze(reason)
  local answers={}
  for _,a in pairs(s.answers) do if a.questionIndex == s.questionIndex then table.insert(answers,a) end end
  table.sort(answers,function(a,b) return a.playerId < b.playerId end)
  local closed={questionIndex=s.questionIndex,phaseVersion=s.phaseVersion,closedAt=now,reason=reason,
    requiredPlayerIds=s.requiredPlayerIds,eligiblePlayerIds=s.eligiblePlayerIds,answers=answers}
  closed.hash=sha256(cjson.encode(closed))
  s.closedQuestions[tostring(s.questionIndex)]=closed; s.accepting=false
  return closed
end
if expired then return err('ROOM_EXPIRED') end
local p=s.players[op.playerId]
if not p then return err('INVALID_SESSION_TOKEN') end
if p.kickedAt ~= cjson.null then return err('PLAYER_KICKED') end
if p.connectionGeneration ~= op.generation then return err('SESSION_REPLACED') end
local question=s.quiz.questions[op.questionIndex+1]
if not question or question.id ~= op.questionId then return err('QUESTION_MISMATCH') end
-- Unicode/type validation also runs in the typed adapter before this script.
local answer=op.answer
if question.type == 'TYPE_ANSWER' then
  if type(answer) ~= 'string' or #answer == 0 or #answer > 32000 then return err('INVALID_ANSWER') end
elseif question.type == 'ORDER_PUZZLE' or question.type == 'MULTIPLE_SELECT' then
  if type(answer) ~= 'table' or #answer < 1 or #answer > 4 or (question.type == 'ORDER_PUZZLE' and #answer ~= 4) then return err('INVALID_ANSWER') end
  local seen={}
  for _,v in ipairs(answer) do
    if type(v) ~= 'number' or v%1 ~= 0 or v < 0 or v >= #question.publicOptions or seen[v] then return err('INVALID_ANSWER') end
    seen[v]=true
  end
  if question.type == 'MULTIPLE_SELECT' then table.sort(answer) end
else
  if type(answer) ~= 'number' or answer%1 ~= 0 or answer < 0 or answer >= #question.publicOptions then return err('INVALID_ANSWER') end
end
local payloadHash=sha256(cjson.encode(answer))
local key=tostring(op.questionIndex)..':'..op.playerId
local prior=s.answers[key]
if prior then
  if prior.submissionId == op.submissionId and prior.payloadHash == payloadHash then return cjson.encode({answer=prior}) end
  return err('ALREADY_ANSWERED')
end
if s.questionIndex ~= op.questionIndex then return err('QUESTION_MISMATCH') end
if s.phase ~= 'QUESTION_ANSWERING' or not s.accepting then return err('INVALID_PHASE') end
if s.timing.acceptanceClosesAt == cjson.null or now > s.timing.acceptanceClosesAt then return err('TIME_EXPIRED') end
local accepted={playerId=op.playerId,submissionId=op.submissionId,questionIndex=op.questionIndex,questionId=op.questionId,
  answer=answer,payloadHash=payloadHash,receivedAt=now,responseTimeMs=math.max(0,now-s.timing.questionStartedAt)}
s.answers[key]=accepted
local eligible=false
for _,id in ipairs(s.eligiblePlayerIds) do if id == op.playerId then eligible=true end end
if not eligible then table.insert(s.eligiblePlayerIds,op.playerId) end
local all=#s.requiredPlayerIds > 0
for _,id in ipairs(s.requiredPlayerIds) do if not s.answers[tostring(s.questionIndex)..':'..id] then all=false end end
if all then freeze('ALL_ANSWERED') end
write(true)
return cjson.encode({answer=accepted,revision=s.revision,frozen=not s.accepting})
