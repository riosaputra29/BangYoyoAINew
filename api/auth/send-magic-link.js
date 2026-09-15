import { signTanyaToken } from '../../lib/auth.js';

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  try{
    const email = String(req.body?.email || '').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      return res.status(400).json({error:'Email tidak valid.'});
    }

    if(!process.env.RESEND_API_KEY) return res.status(500).json({error:'RESEND_API_KEY belum diset di Vercel.'});
    if(!process.env.EMAIL_FROM) return res.status(500).json({error:'EMAIL_FROM belum diset di Vercel.'});

    const now = Math.floor(Date.now()/1000);
    const token = await signTanyaToken({
      type:'magic',
      email,
      iat:now,
      exp:now + 15 * 60
    });

    const origin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const link = `${origin}/api/auth/verify-magic-link?token=${encodeURIComponent(token)}`;

    const response = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{
        'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        from:process.env.EMAIL_FROM,
        to:[email],
        subject:'Masuk ke Tanya AI',
        html:`
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:40px auto;padding:32px;border:1px solid #e5e5e5;border-radius:18px">
            <h2 style="margin:0 0 10px">Masuk ke Tanya AI</h2>
            <p style="color:#666;line-height:1.6">Klik tombol di bawah untuk masuk tanpa password. Link ini berlaku selama 15 menit.</p>
            <p style="margin:28px 0"><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px">Masuk ke Tanya</a></p>
            <p style="font-size:12px;color:#999">Jika kamu tidak meminta login ini, abaikan email ini.</p>
          </div>`
      })
    });

    if(!response.ok){
      const detail = await response.text();
      console.error('Resend error:', detail);
      return res.status(502).json({error:'Email gagal dikirim. Periksa konfigurasi Resend/domain.'});
    }

    return res.status(200).json({ok:true});
  }catch(error){
    console.error(error);
    return res.status(500).json({error:'Terjadi kesalahan saat mengirim magic link.'});
  }
}
