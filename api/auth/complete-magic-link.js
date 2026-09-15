
import { signTanyaToken, verifyTanyaToken } from '../../lib/auth.js';

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  try{
    const magicToken = String(req.body?.token || '');
    const magic = await verifyTanyaToken(magicToken);
    if(magic.type !== 'magic' || !magic.email) throw new Error('Invalid magic token');

    const now = Math.floor(Date.now()/1000);
    const user = {
      sub:`email:${magic.email}`,
      email:magic.email,
      name:magic.email.split('@')[0],
      picture:'',
      auth_provider:'magic_link'
    };

    const session = await signTanyaToken({
      type:'session',
      ...user,
      iat:now,
      exp:now + 7 * 24 * 60 * 60
    });

    return res.status(200).json({ok:true, token:session, user});
  }catch(error){
    console.error(error);
    return res.status(401).json({error:'Magic link tidak valid atau sudah kedaluwarsa.'});
  }
}
