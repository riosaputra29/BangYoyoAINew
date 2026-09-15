// Shared authentication helpers for Google + Tanya Magic Link.
// No JWT package is required.

const encoder = new TextEncoder();

function base64url(input){
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for(const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, 'binary').toString('base64url');
}

function base64urlJson(value){
  return base64url(JSON.stringify(value));
}

function timingSafeEqual(a, b){
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if(aa.length !== bb.length) return false;
  let diff = 0;
  for(let i=0;i<aa.length;i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function hmac(secret, data){
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

export async function signTanyaToken(payload){
  const header = {alg:'HS256',typ:'JWT'};
  const encodedHeader = base64urlJson(header);
  const encodedPayload = base64urlJson(payload);
  const data = encodedHeader + '.' + encodedPayload;
  const signature = base64url(await hmac(process.env.MAGIC_LINK_SECRET, data));
  return data + '.' + signature;
}

export async function verifyTanyaToken(token){
  if(!process.env.MAGIC_LINK_SECRET) throw new Error('MAGIC_LINK_SECRET belum diset.');
  if(typeof token !== 'string') throw new Error('Token tidak valid.');

  const parts = token.split('.');
  if(parts.length !== 3) throw new Error('Token tidak valid.');

  const [header, payload, signature] = parts;
  const expected = base64url(await hmac(process.env.MAGIC_LINK_SECRET, header + '.' + payload));
  if(!timingSafeEqual(signature, expected)) throw new Error('Signature token tidak valid.');

  let data;
  try{
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }catch{
    throw new Error('Payload token tidak valid.');
  }

  if(!data.exp || Date.now() >= data.exp * 1000) throw new Error('Token sudah kedaluwarsa.');
  return data;
}

export function getBearerToken(req){
  const auth = req.headers.authorization || '';
  if(!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

export async function verifyMagicSessionFromRequest(req){
  const token = getBearerToken(req);
  if(!token) throw new Error('Unauthorized');
  const data = await verifyTanyaToken(token);
  if(data.type !== 'session') throw new Error('Unauthorized');
  return data;
}
