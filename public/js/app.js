
// =========================================================
// KONFIGURASI
// =========================================================

const GOOGLE_CLIENT_ID =
  "475879074184-5fu3p4oci9o3rbl8khtnv2260k6k7bc2.apps.googleusercontent.com";

// Chat memanggil backend sendiri:
// /api/chat
//
// Backend yang menyimpan API key dan meneruskan permintaan
// ke provider AI.

// Untuk gambar:
// { type:"image_url", image_url:{url:dataURL} }

const DUMMY_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%232c2f38'/%3E%3Ccircle cx='32' cy='25' r='12' fill='%238f929e'/%3E%3Cellipse cx='32' cy='58' rx='20' ry='16' fill='%238f929e'/%3E%3C/svg%3E";


// =========================================================
// UPLOAD CONFIG
// =========================================================

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 300 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS_IN_PROMPT = 20000;

const TEXTLIKE_EXT = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.log'
];


// =========================================================
// STATE
// =========================================================

let history = [];

let userProfile = null;

let pendingAttachment = null;

let conversationsList = [];

let currentConversationId = null;


// =========================================================
// JWT
// =========================================================

function decodeJwt(token){

  const payload = token.split('.')[1];

  return JSON.parse(
    atob(
      payload
        .replace(/-/g,'+')
        .replace(/_/g,'/')
    )
  );
}


function isTokenExpired(token){

  try{

    const { exp } = decodeJwt(token);

    return !exp ||
      (Date.now() / 1000) > exp;

  }catch(e){

    return true;

  }
}


// =========================================================
// SHOW CHAT
// =========================================================

function showChatScreen(){

  document.getElementById('user-avatar').src =
    userProfile.picture || DUMMY_AVATAR;

  document.getElementById('user-name').textContent =
    userProfile.name || 'User';

  document.getElementById('login-screen').style.display =
    'none';

  document.getElementById('chat-screen').style.display =
    'flex';
}


// =========================================================
// GOOGLE LOGIN
// =========================================================

function handleCredentialResponse(response){

  userProfile = decodeJwt(
    response.credential
  );

  localStorage.setItem(
    'id_token',
    response.credential
  );

  showChatScreen();

  loadConversations(true);
  loadProjects(true);

  document.getElementById(
    'chat-input'
  ).focus();
}


// =========================================================
// MAGIC LINK LOGIN
// =========================================================

function setMagicStatus(message, type=''){
  const el = document.getElementById('magic-link-status');
  if(!el) return;
  el.textContent = message || '';
  el.className = 'magic-link-status' + (type ? ' ' + type : '');
}

async function sendMagicLink(email){
  const btn = document.getElementById('magic-link-btn');
  const input = document.getElementById('magic-email');
  if(btn) btn.disabled = true;
  setMagicStatus('Mengirim link login ke email kamu...');

  try{
    const response = await fetch('/api/auth/send-magic-link', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(data.error || 'Gagal mengirim magic link.');
    setMagicStatus('Magic link sudah dikirim. Cek inbox atau folder spam email kamu.', 'success');
    if(input) input.value = '';
  }catch(e){
    console.error('Magic link error:', e);
    setMagicStatus(e.message || 'Gagal mengirim magic link.', 'error');
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function completeMagicLogin(token){
  if(!token) return false;
  setMagicStatus('Memverifikasi link login...');

  try{
    const response = await fetch('/api/auth/complete-magic-link', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token})
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok || !data.token) throw new Error(data.error || 'Magic link tidak valid atau sudah kedaluwarsa.');

    localStorage.setItem('id_token', data.token);
    userProfile = data.user || decodeJwt(data.token);

    // Hilangkan token dari address bar dan history browser.
    window.history.replaceState({}, document.title, window.location.pathname);

    showChatScreen();
    await loadConversations(true);
    document.getElementById('chat-input').focus();
    return true;
  }catch(e){
    console.error('Magic link verification error:', e);
    window.history.replaceState({}, document.title, window.location.pathname);
    setMagicStatus(e.message || 'Magic link tidak valid.', 'error');
    return false;
  }
}

function initMagicLink(){
  const form = document.getElementById('magic-link-form');
  if(form){
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const email = document.getElementById('magic-email').value.trim();
      if(email) sendMagicLink(email);
    });
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('magic_token');
  if(token) completeMagicLogin(token);
}


// =========================================================
// WINDOW LOAD
// =========================================================

window.onload = function(){

  try{

    initMagicLink();

    google.accounts.id.initialize({
      client_id:GOOGLE_CLIENT_ID,
      callback:handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: false
    });

    const googleBtnContainer =
      document.getElementById('google-btn-container');

    google.accounts.id.renderButton(
      googleBtnContainer,
      {
        theme:'outline',
        size:'large',
        shape:'pill',
        text:'signin_with',
        width: Math.min(googleBtnContainer.offsetWidth || 300, 400)
      }

    );


    const savedToken =
      localStorage.getItem('id_token');

    const hasMagicToken =
      new URLSearchParams(window.location.search).has('magic_token');


    if(savedToken && !isTokenExpired(savedToken)){
      userProfile = decodeJwt(savedToken);
      restoreSession();   // ganti showChatScreen() + loadConversations(true) dengan ini
    }else if(!hasMagicToken){
      localStorage.removeItem('id_token');
      google.accounts.id.prompt();
    }

  }catch(e){

    console.error(e);

    document.getElementById(
      'login-error'
    ).style.display = 'block';

  }

};


// =========================================================
// SIGN OUT
// =========================================================

document
  .getElementById('signout-btn')
  .addEventListener('click', () => {

    // Hapus session aplikasi
    localStorage.removeItem('id_token');
    localStorage.removeItem('userProfile');

    // Matikan auto-select Google
    if (window.google?.accounts?.id) {
      google.accounts.id.disableAutoSelect();
    }

    // Reset user
    userProfile = null;

    // Reset chat
    history = [];
    conversationsList = [];
    currentConversationId = null;

    clearAttachment();

    document.getElementById('messages').innerHTML =
      emptyStateHTML;

    // Tutup sidebar
    closeSidebar();

    // Kembali ke login
    document.getElementById('chat-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';

    // Render ulang Google Login
    const googleBtnContainer =
      document.getElementById('google-btn-container');

    if (
      googleBtnContainer &&
      window.google?.accounts?.id
    ) {
      googleBtnContainer.innerHTML = '';

      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: false
      });

      google.accounts.id.renderButton(
        googleBtnContainer,
        {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
          width: Math.min(
            googleBtnContainer.offsetWidth || 300,
            400
          )
        }
      );
    }

  });


// =========================================================
// DOM REFERENCES
// =========================================================

const input =
  document.getElementById('chat-input');

const sendBtn =
  document.getElementById('send-btn');

const startVoiceBtn =
  document.getElementById('start-voice-btn');



// =========================================================
// DYNAMIC SEND BUTTON
// =========================================================

function updateSendButton() {
  if (!input || !sendBtn) return;

  const hasText = input.value.trim().length > 0;

  if (hasText && !aiSpeaking) {
    sendBtn.classList.add('visible');

    if (startVoiceBtn) {
      startVoiceBtn.style.display = 'none';
    }
  } else {
    sendBtn.classList.remove('visible');

    if (startVoiceBtn) {
      startVoiceBtn.style.display = 'flex';
    }
  }
}


// =========================================================
// DETEKSI SAAT USER MENGETIK
// =========================================================

if (input) {

  input.addEventListener(
    'input',
    updateSendButton
  );

}


// =========================================================
// KONDISI AWAL
// =========================================================

updateSendButton();

const messagesEl =
  document.getElementById('messages');

const headerEl =
  document.querySelector(
    '#chat-screen header'
  );

const scrollBtn =
  document.getElementById('scroll-bottom');

const emptyStateHTML =
  document.getElementById(
    'empty-state'
  ).outerHTML;


// UPLOAD

const fileInput =
  document.getElementById('file-input');

const attachBtn =
  document.getElementById('attach-btn');

const attPreview =
  document.getElementById(
    'attachment-preview'
  );

const attImgPreview =
  document.getElementById(
    'att-img-preview'
  );

const attFileIcon =
  document.getElementById(
    'att-file-icon'
  );

const attName =
  document.getElementById(
    'att-name'
  );

const attSize =
  document.getElementById(
    'att-size'
  );

const attRemove =
  document.getElementById(
    'att-remove'
  );


// SIDEBAR

const sidebarEl =
  document.getElementById(
    'sidebar'
  );

const sidebarToggleBtn =
  document.getElementById(
    'sidebar-toggle-btn'
  );

const sidebarBackdrop =
  document.getElementById(
    'sidebar-backdrop'
  );

const newChatBtn =
  document.getElementById(
    'new-chat-btn'
  );

const sidebarChatListEl =
  document.getElementById(
    'sidebar-chat-list'
  );


// =========================================================
// SIDEBAR
// =========================================================

function openSidebar(){

  sidebarEl.classList.add(
    'open'
  );

  sidebarBackdrop.classList.add(
    'visible'
  );

}


function closeSidebar(){

  sidebarEl.classList.remove(
    'open'
  );

  sidebarBackdrop.classList.remove(
    'visible'
  );

}


sidebarToggleBtn.addEventListener(
  'click',
  () => {

    sidebarEl.classList.contains('open')
      ? closeSidebar()
      : openSidebar();

  }
);


sidebarBackdrop.addEventListener(
  'click',
  closeSidebar
);


// =========================================================
// LOAD CONVERSATIONS
// =========================================================

async function loadConversations(
  selectFirst
){

  const idToken =
    localStorage.getItem(
      'id_token'
    );

  if(!idToken) return;


  try{

    const response =
      await fetch(
        '/api/conversations',
        {
          headers:{
            'Authorization':
              'Bearer ' + idToken
          }
        }
      );


    if(!response.ok) return;


    const data =
      await response.json();


    conversationsList =
      Array.isArray(
        data.conversations
      )
      ? data.conversations
      : [];


    renderConversationList();


    if(
      selectFirst &&
      conversationsList.length > 0 &&
      currentConversationId === null
    ){

      await selectConversation(
        conversationsList[0].id
      );

    }

  }catch(e){

    console.error(
      'Gagal memuat daftar percakapan:',
      e
    );

  }

}


// =========================================================
// RENDER CONVERSATION LIST
// =========================================================

function renderConversationList(){

  sidebarChatListEl.innerHTML = '';


  if(
    conversationsList.length === 0
  ){

    const note =
      document.createElement(
        'div'
      );

    note.className =
      'sidebar-empty-note';

    note.textContent =
      'Belum ada percakapan. Mulai ngobrol untuk membuat yang pertama.';

    sidebarChatListEl.appendChild(
      note
    );

    return;

  }


  for(
    const conv of conversationsList
  ){

    const item =
      document.createElement(
        'div'
      );


    item.className =
      'sidebar-chat-item' +
      (
        Number(conv.id) ===
        Number(currentConversationId)
          ? ' active'
          : ''
      );


    item.innerHTML = `

      <button
        type="button"
        class="sidebar-chat-main"
        aria-label="Buka percakapan"
      >

        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>

        <span></span>

      </button>


      <button
        type="button"
        class="sidebar-delete-btn"
        title="Hapus percakapan"
        aria-label="Hapus percakapan"
      >

        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3 6h18"/>
          <path d="M8 6V4h8v2"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v5"/>
          <path d="M14 11v5"/>
        </svg>

      </button>

    `;


    const mainBtn =
      item.querySelector(
        '.sidebar-chat-main'
      );


    mainBtn
      .querySelector('span')
      .textContent =
      conv.title ||
      'Percakapan';


    mainBtn.title =
      conv.title ||
      'Percakapan';


    mainBtn.addEventListener(
      'click',
      () =>
        selectConversation(
          conv.id
        )
    );


    item
      .querySelector(
        '.sidebar-delete-btn'
      )
      .addEventListener(
        'click',
        (e) => {

          e.preventDefault();

          e.stopPropagation();

          deleteConversationFromSidebar(
            conv.id
          );

        }
      );


    sidebarChatListEl.appendChild(
      item
    );

  }

}


// =========================================================
// DELETE CONVERSATION
// =========================================================

async function deleteConversationFromSidebar(
  conversationId
){

  const conversation =
    conversationsList.find(
      c =>
        Number(c.id) ===
        Number(conversationId)
    );


  if(!conversation) return;


  const title =
    conversation.title ||
    'Percakapan';


  const confirmed =
    confirm(
      `Hapus percakapan "${title}"?\n\nSemua pesan dalam percakapan ini akan dihapus.`
    );


  if(!confirmed) return;


  const idToken =
    localStorage.getItem(
      'id_token'
    );


  if(!idToken){

    alert(
      'Sesi login sudah habis. Silakan login kembali.'
    );

    return;

  }


  try{

    const response =
      await fetch(
        '/api/conversations?conversationId=' +
        encodeURIComponent(
          conversationId
        ),
        {
          method:'DELETE',

          headers:{
            'Authorization':
              'Bearer ' + idToken
          }
        }
      );


    const data =
      await response
        .json()
        .catch(
          () => ({})
        );


    if(!response.ok){

      throw new Error(
        data.error ||
        'Gagal menghapus percakapan.'
      );

    }


    conversationsList =
      conversationsList.filter(
        c =>
          Number(c.id) !==
          Number(conversationId)
      );


    if(
      Number(currentConversationId) ===
      Number(conversationId)
    ){

      currentConversationId =
        null;

      history = [];

      clearAttachment();

      document.getElementById(
        'messages'
      ).innerHTML =
        emptyStateHTML;

    }


    renderConversationList();

  }catch(e){

    console.error(
      'Delete conversation error:',
      e
    );

    alert(
      e.message ||
      'Gagal menghapus percakapan.'
    );

  }

}


// =========================================================
// SELECT CONVERSATION
// =========================================================

async function selectConversation(
  conversationId
){

  if(
    conversationId ===
    currentConversationId
  ){

    closeSidebar();

    return;

  }


  currentConversationId =
    conversationId;


  renderConversationList();


  history = [];


  document.getElementById(
    'messages'
  ).innerHTML =
    emptyStateHTML;


  await loadChatHistory(
    conversationId
  );


  closeSidebar();

}


// =========================================================
// NEW CHAT
// =========================================================

newChatBtn.addEventListener(
  'click',
  () => {

    if(
      history.length > 0 &&
      !confirm(
        'Mulai percakapan baru? Tampilan chat saat ini akan dikosongkan.'
      )
    ){

      return;

    }


    currentConversationId =
      null;

    history = [];

    clearAttachment();


    document.getElementById(
      'messages'
    ).innerHTML =
      emptyStateHTML;


    renderConversationList();

    closeSidebar();

    input.focus();

  }
);


// =========================================================
// MESSAGE CLICK
// =========================================================

document
  .getElementById('messages')
  .addEventListener(
    'click',
    (e) => {

      const chip =
        e.target.closest(
          '.chip'
        );


      if(chip){

        input.value =
          chip.dataset.prompt +
          ' ';

        input.focus();

        input.dispatchEvent(
          new Event('input')
        );

        return;

      }


      const excelBtn =
        e.target.closest(
          '.excel-download-btn'
        );


      if(excelBtn){

        downloadExcelBlock(
          excelBtn.dataset.xlsxId,
          excelBtn
        );

        return;

      }


      const codeCopyBtn =
        e.target.closest(
          '.code-copy-btn'
        );


      if(codeCopyBtn){

        const codeEl =
          codeCopyBtn
            .closest('.code-block')
            .querySelector('code');


        const label =
          codeCopyBtn
            .querySelector('span');


        navigator.clipboard
          .writeText(
            codeEl.textContent
          )
          .then(() => {

            codeCopyBtn.classList.add(
              'copied'
            );

            const original =
              label.textContent;

            label.textContent =
              'Disalin';


            setTimeout(
              () => {

                codeCopyBtn.classList.remove(
                  'copied'
                );

                label.textContent =
                  original;

              },
              1400
            );

          });

      }

    }
  );


// =========================================================
// SCROLL
// =========================================================

function isNearBottom(){

  return (
    messagesEl.scrollHeight -
    messagesEl.scrollTop -
    messagesEl.clientHeight
  ) < 80;

}


messagesEl.addEventListener(
  'scroll',
  () => {

    headerEl.classList.toggle(
      'is-scrolled',
      messagesEl.scrollTop > 4
    );


    scrollBtn.classList.toggle(
      'visible',
      !isNearBottom()
    );

  }
);


scrollBtn.addEventListener(
  'click',
  () => {

    messagesEl.scrollTo({
      top:messagesEl.scrollHeight,
      behavior:'smooth'
    });

  }
);


// =========================================================
// COPY TEXT
// =========================================================

function copyText(
  text,
  btn
){

  navigator.clipboard
    .writeText(text)
    .then(() => {

      btn.textContent = '✓';

      btn.classList.add(
        'copied'
      );


      setTimeout(
        () => {

          btn.textContent = '⧉';

          btn.classList.remove(
            'copied'
          );

        },
        1400
      );

    });

}


// =========================================================
// TIME
// =========================================================

function timeNow(){

  return new Date()
    .toLocaleTimeString(
      'id-ID',
      {
        hour:'2-digit',
        minute:'2-digit'
      }
    );

}


// =========================================================
// FORMAT BYTES
// =========================================================

function formatBytes(
  bytes
){

  if(bytes < 1024)
    return bytes + ' B';

  if(bytes < 1024 * 1024)
    return (
      bytes / 1024
    ).toFixed(0) + ' KB';

  return (
    bytes /
    (1024 * 1024)
  ).toFixed(1) + ' MB';

}


// =========================================================
// EKSTRAK TEKS PDF (pdf.js)
// =========================================================

async function extractPdfText(arrayBuffer){

  if(!window.pdfjsLib){
    throw new Error('pdf.js belum termuat.');
  }

  const pdf =
    await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let text = '';

  for(let pageNum = 1; pageNum <= pdf.numPages; pageNum++){

    const page = await pdf.getPage(pageNum);

    const content = await page.getTextContent();

    const pageText = content.items
      .map(item => item.str)
      .join(' ');

    text += `\n--- Halaman ${pageNum} ---\n` + pageText;

  }

  return text.trim();

}


// =========================================================
// UPLOAD
// =========================================================

attachBtn.addEventListener(
  'click',
  () =>
    fileInput.click()
);


fileInput.addEventListener(
  'change',
  () => {

    const file =
      fileInput.files[0];

    fileInput.value = '';

    if(!file) return;


    const isImage =
      file.type.startsWith(
        'image/'
      );


    const lowerName =
      file.name.toLowerCase();


    const isPdf =
      lowerName.endsWith('.pdf') ||
      file.type === 'application/pdf';


    const isTextLike =
      TEXTLIKE_EXT.some(
        ext =>
          lowerName.endsWith(ext)
      ) ||
      file.type.startsWith('text/') ||
      file.type ===
        'application/json';


    if(
      !isImage &&
      !isTextLike &&
      !isPdf
    ){

      alert(
        'Jenis file ini belum didukung. Gunakan gambar (JPG/PNG/dll), PDF, atau file teks (.txt, .md, .csv, .json, .log).'
      );

      return;

    }


    if(
      isImage &&
      file.size >
      MAX_IMAGE_BYTES
    ){

      alert(
        'Gambar terlalu besar (maks ' +
        formatBytes(
          MAX_IMAGE_BYTES
        ) +
        ').'
      );

      return;

    }


    if(
      isTextLike &&
      file.size >
      MAX_TEXT_BYTES
    ){

      alert(
        'File terlalu besar (maks ' +
        formatBytes(
          MAX_TEXT_BYTES
        ) +
        ').'
      );

      return;

    }


    if(
      isPdf &&
      file.size >
      MAX_PDF_BYTES
    ){

      alert(
        'File PDF terlalu besar (maks ' +
        formatBytes(
          MAX_PDF_BYTES
        ) +
        ').'
      );

      return;

    }


    const reader =
      new FileReader();


    if(isImage){

      reader.onload = () => {

        pendingAttachment = {

          kind:'image',

          name:file.name,

          size:file.size,

          dataUrl:reader.result

        };


        showAttachmentPreview();

      };


      reader.onerror =
        () =>
          alert(
            'Gagal membaca gambar.'
          );


      reader.readAsDataURL(
        file
      );

    }else if(isPdf){

      reader.onload = async () => {

        try{

          const rawText =
            await extractPdfText(
              reader.result
            );

          let text = rawText;

          let truncated = false;


          if(
            !text ||
            text.trim() === ''
          ){

            text =
              '[Tidak ada teks yang bisa diekstrak dari PDF ini. Kemungkinan PDF berupa hasil scan/gambar tanpa lapisan teks.]';

          }


          if(
            text.length >
            MAX_TEXT_CHARS_IN_PROMPT
          ){

            text =
              text.slice(
                0,
                MAX_TEXT_CHARS_IN_PROMPT
              );

            truncated = true;

          }


          pendingAttachment = {

            kind:'text',

            name:file.name,

            size:file.size,

            text:text,

            truncated:truncated

          };


          showAttachmentPreview();

        }catch(err){

          console.error(
            'Gagal membaca PDF:',
            err
          );

          const notLoaded =
            !window.pdfjsLib;

          alert(
            notLoaded
              ? 'Fitur baca PDF belum siap (pdf.js gagal dimuat dari CDN). Coba refresh halaman, atau periksa koneksi/adblocker.'
              : 'Gagal membaca isi PDF. Pastikan file tidak rusak atau terkunci password.'
          );

        }

      };


      reader.onerror =
        () =>
          alert(
            'Gagal membaca file PDF.'
          );


      reader.readAsArrayBuffer(
        file
      );

    }else{

      reader.onload = () => {

        let text =
          reader.result;

        let truncated =
          false;


        if(
          text.length >
          MAX_TEXT_CHARS_IN_PROMPT
        ){

          text =
            text.slice(
              0,
              MAX_TEXT_CHARS_IN_PROMPT
            );

          truncated = true;

        }


        pendingAttachment = {

          kind:'text',

          name:file.name,

          size:file.size,

          text:text,

          truncated:truncated

        };


        showAttachmentPreview();

      };


      reader.onerror =
        () =>
          alert(
            'Gagal membaca file.'
          );


      reader.readAsText(
        file
      );

    }

  }
);


// =========================================================
// ATTACHMENT PREVIEW
// =========================================================

function showAttachmentPreview(){

  if(!pendingAttachment)
    return;


  attPreview.classList.add(
    'visible'
  );


  attName.textContent =
    pendingAttachment.name;


  attSize.textContent =
    formatBytes(
      pendingAttachment.size
    );


  if(
    pendingAttachment.kind ===
    'image'
  ){

    attImgPreview.src =
      pendingAttachment.dataUrl;

    attImgPreview.style.display =
      'block';

    attFileIcon.style.display =
      'none';

  }else{

    attImgPreview.style.display =
      'none';

    attFileIcon.style.display =
      'flex';

  }

}


function clearAttachment(){

  pendingAttachment =
    null;

  attPreview.classList.remove(
    'visible'
  );

  attImgPreview.src =
    '';

  attImgPreview.style.display =
    'none';

  attFileIcon.style.display =
    'none';

}


attRemove.addEventListener(
  'click',
  clearAttachment
);


// =========================================================
// ESCAPE HTML
// =========================================================

function escapeHtml(
  str
){

  return str
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    );

}


// =========================================================
// CODE COPY ICON
// =========================================================

const COPY_ICON_SVG =

  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +

  '<rect x="9" y="9" width="13" height="13" rx="2"/>' +

  '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +

  '</svg>';


// =========================================================
// EXCEL ICON
// =========================================================

const EXCEL_ICON_SVG =

  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +

  '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +

  '<path d="M14 2v6h6"/>' +

  '<path d="M9.5 12.5l5 5M14.5 12.5l-5 5"/>' +

  '</svg>';


// =========================================================
// EXCEL BLOCK REGISTRY
// Menyimpan data CSV mentah per blok "excel" supaya bisa
// diambil lagi saat tombol download diklik, tanpa perlu
// menaruh data mentah di atribut HTML.
// =========================================================

let excelBlockCounter = 0;

const excelBlockRegistry = {};


function buildExcelBlockHtml(
  csvCode
){

  const blockId =
    'xlsx-' +
    Date.now() +
    '-' +
    (excelBlockCounter++);


  excelBlockRegistry[blockId] =
    csvCode;


  return (

    '<div class="excel-block">' +

      '<div class="excel-block-icon">' +

        EXCEL_ICON_SVG +

      '</div>' +

      '<div class="excel-block-info">' +

        '<div class="excel-block-title">Data Excel siap diunduh</div>' +

        '<div class="excel-block-sub">Klik untuk mengunduh sebagai file .xlsx</div>' +

      '</div>' +

      '<button class="excel-download-btn" type="button" data-xlsx-id="' +

        blockId +

      '">Unduh Excel</button>' +

    '</div>'

  );

}


// =========================================================
// TRIGGER DOWNLOAD EXCEL
// =========================================================

function downloadExcelBlock(
  blockId,
  btnEl
){

  const csvCode =
    excelBlockRegistry[blockId];


  if(!window.XLSX){

    alert(
      'Library Excel (SheetJS) belum termuat. Coba refresh halaman lalu coba lagi.'
    );

    return;

  }


  if(
    typeof csvCode !== 'string' ||
    csvCode.trim() === ''
  ){

    alert(
      'Data untuk file Excel ini tidak ditemukan. Coba minta AI generate ulang.'
    );

    return;

  }


  try{

    const workbook =
      XLSX.read(
        csvCode,
        { type:'string' }
      );

    const filename =
      'tanya-data-' +
      Date.now() +
      '.xlsx';

    XLSX.writeFile(
      workbook,
      filename
    );

  }catch(err){

    console.error(
      'Gagal membuat file Excel:',
      err
    );

    if(btnEl){

      btnEl.classList.add(
        'error'
      );

      btnEl.textContent =
        'Gagal, coba lagi';


      setTimeout(
        () => {

          btnEl.classList.remove(
            'error'
          );

          btnEl.textContent =
            'Unduh Excel';

        },
        2200
      );

    }else{

      alert(
        'Gagal membuat file Excel dari data ini.'
      );

    }

  }

}


// =========================================================
// CODE BLOCK
// =========================================================

function buildCodeBlockHtml(
  lang,
  code
){

  const label =
    lang
      ? lang.toLowerCase()
      : 'teks';


  return (

    '<div class="code-block">' +

      '<div class="code-block-header">' +

        '<span class="code-lang">' +

          escapeHtml(label) +

        '</span>' +

        '<button class="code-copy-btn" type="button">' +

          COPY_ICON_SVG +

          '<span>Salin</span>' +

        '</button>' +

      '</div>' +

      '<pre><code>' +

        code +

      '</code></pre>' +

    '</div>'

  );

}


// =========================================================
// MARKDOWN RENDERER
// =========================================================

function renderMarkdown(raw){

  if(
    raw === null ||
    raw === undefined
  ){
    return '';
  }

  let source =
    String(raw)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

  // =======================================================
  // NORMALIZE AI MARKDOWN
  // =======================================================

  // AI kadang menghasilkan:
  // \## Judul
  // \| A | B |
  //
  // Kembalikan ke Markdown normal.

  source =
    source.replace(
      /^\\(#{1,6})\s/gm,
      '$1 '
    );

  source =
    source.replace(
      /^\\\|/gm,
      '|'
    );

  // Hanya perbaiki escaped pipe yang memang
  // terlihat seperti tabel.
  const sourceLines =
    source.split('\n');

  let inTable = false;

  source =
    sourceLines
      .map(line => {

        const trimmed =
          line.trim();

        if(
          trimmed.startsWith('|')
        ){
          inTable = true;

          return line.replace(
            /\\\|/g,
            '|'
          );
        }

        if(
          inTable &&
          /^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/
            .test(trimmed)
        ){
          return line.replace(
            /\\\|/g,
            '|'
          );
        }

        if(
          trimmed === ''
        ){
          inTable = false;
        }

        return line;
      })
      .join('\n');


  // =======================================================
  // CODE BLOCK EXTRACTION
  // =======================================================

  const codeBlocks = [];

  source =
    source.replace(
      /```([a-zA-Z0-9_+#.-]*)[ \t]*\n?([\s\S]*?)```/g,

      (
        match,
        lang,
        code
      ) => {

        const index =
          codeBlocks.length;

        codeBlocks.push({
          lang:
            (lang || '')
              .trim()
              .toLowerCase(),

          code:
            code.replace(
              /\n$/,
              ''
            )
        });

        return (
          '\n' +
          '\u0000CODEBLOCK' +
          index +
          '\u0000' +
          '\n'
        );
      }
    );


  // =======================================================
  // ESCAPE HTML
  // =======================================================

  let text =
    escapeHtml(source);


  // =======================================================
  // INLINE CODE
  // =======================================================

  text =
    text.replace(
      /`([^`\n]+)`/g,
      '<code>$1</code>'
    );


  // =======================================================
  // BOLD
  // =======================================================

  text =
    text.replace(
      /\*\*([^*\n]+)\*\*/g,
      '<strong>$1</strong>'
    );


  // =======================================================
  // ITALIC
  // =======================================================

  text =
    text.replace(
      /(^|[^\*])\*([^*\n]+)\*(?!\*)/g,
      '$1<em>$2</em>'
    );


  // =======================================================
  // STRIKETHROUGH
  // =======================================================

  text =
    text.replace(
      /~~([^~\n]+)~~/g,
      '<del>$1</del>'
    );


  const lines =
    text.split('\n');


  let html = '';

  let listType =
    null;


  // =======================================================
  // HELPERS
  // =======================================================

  function closeList(){

    if(!listType){
      return;
    }

    html +=
      listType === 'ol'
        ? '</ol>'
        : '</ul>';

    listType =
      null;
  }


  function isTableSeparator(line){

    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
      .test(line);
  }


  function parseTableRow(line){

    let value =
      line.trim();

    if(
      value.startsWith('|')
    ){
      value =
        value.slice(1);
    }

    if(
      value.endsWith('|')
    ){
      value =
        value.slice(
          0,
          -1
        );
    }

    return value
      .split('|')
      .map(
        cell =>
          cell.trim()
      );
  }


  function renderTable(
    startIndex
  ){

    const header =
      parseTableRow(
        lines[startIndex]
      );

    const separator =
      lines[startIndex + 1];

    if(
      !header.length ||
      !isTableSeparator(
        separator
      )
    ){
      return null;
    }

    let end =
      startIndex + 2;

    const rows = [];

    while(
      end < lines.length
    ){

      const line =
        lines[end];

      if(
        !line.trim() ||
        !line.includes('|')
      ){
        break;
      }

      rows.push(
        parseTableRow(line)
      );

      end++;
    }

    let table =
      '<div class="md-table-wrap">' +
      '<table>' +
      '<thead>' +
      '<tr>';

    header.forEach(
      cell => {

        table +=
          '<th>' +
          cell +
          '</th>';
      }
    );

    table +=
      '</tr>' +
      '</thead>' +
      '<tbody>';


    rows.forEach(
      row => {

        table +=
          '<tr>';

        for(
          let i = 0;
          i < header.length;
          i++
        ){

          table +=
            '<td>' +
            (row[i] || '') +
            '</td>';
        }

        table +=
          '</tr>';
      }
    );


    table +=
      '</tbody>' +
      '</table>' +
      '</div>';


    return {
      html: table,
      end
    };
  }


  // =======================================================
  // MAIN PARSER
  // =======================================================

  for(
    let i = 0;
    i < lines.length;
    i++
  ){

    const line =
      lines[i];

    const trimmed =
      line.trim();


    // -----------------------------------------------------
    // EMPTY LINE
    // -----------------------------------------------------

    if(
      trimmed === ''
    ){

      closeList();

      continue;
    }


    // -----------------------------------------------------
    // CODE BLOCK
    // -----------------------------------------------------

    const codeMatch =
      trimmed.match(
        /^\u0000CODEBLOCK(\d+)\u0000$/
      );

    if(codeMatch){

      closeList();

      const block =
        codeBlocks[
          Number(
            codeMatch[1]
          )
        ];

      if(
        block &&
        block.lang === 'excel'
      ){

        html +=
          buildExcelBlockHtml(
            block.code
          );

      }else if(block){

        html +=
          buildCodeBlockHtml(
            block.lang,
            escapeHtml(
              block.code
            )
          );
      }

      continue;
    }


    // -----------------------------------------------------
    // HEADING
    // -----------------------------------------------------

    const heading =
      trimmed.match(
        /^(#{1,6})\s+(.+)$/
      );

    if(heading){

      closeList();

      const level =
        heading[1].length;

      const content =
        heading[2]
          .trim();

      html +=
        `<h${level}>${content}</h${level}>`;

      continue;
    }


    // -----------------------------------------------------
    // HORIZONTAL RULE
    // -----------------------------------------------------

    if(
      /^(\*{3,}|-{3,}|_{3,})$/
        .test(trimmed)
    ){

      closeList();

      html +=
        '<hr>';

      continue;
    }


    // -----------------------------------------------------
    // TABLE
    // -----------------------------------------------------

    if(
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(
        lines[i + 1]
      )
    ){

      closeList();

      const table =
        renderTable(i);

      if(table){

        html +=
          table.html;

        i =
          table.end - 1;

        continue;
      }
    }


    // -----------------------------------------------------
    // BULLET
    // -----------------------------------------------------

    const bullet =
      trimmed.match(
        /^[-*+]\s+(.+)$/
      );

    if(bullet){

      if(
        listType !== 'ul'
      ){

        closeList();

        html +=
          '<ul>';

        listType =
          'ul';
      }

      html +=
        '<li>' +
        bullet[1] +
        '</li>';

      continue;
    }


    // -----------------------------------------------------
    // NUMBERED LIST
    // -----------------------------------------------------

    const numbered =
      trimmed.match(
        /^\d+[.)]\s+(.+)$/
      );

    if(numbered){

      if(
        listType !== 'ol'
      ){

        closeList();

        html +=
          '<ol>';

        listType =
          'ol';
      }

      html +=
        '<li>' +
        numbered[1] +
        '</li>';

      continue;
    }


    // -----------------------------------------------------
    // BLOCKQUOTE
    // -----------------------------------------------------

    const quote =
      trimmed.match(
        /^>\s?(.*)$/
      );

    if(quote){

      closeList();

      html +=
        '<blockquote>' +
        quote[1] +
        '</blockquote>';

      continue;
    }


    // -----------------------------------------------------
    // NORMAL PARAGRAPH
    // -----------------------------------------------------

    closeList();

    html +=
      '<p>' +
      line +
      '</p>';
  }


  closeList();


  // =======================================================
  // RESTORE LATEX
  // =======================================================

  html =
    html.replace(
      /\$\$([\s\S]*?)\$\$/g,
      (
        match,
        formula
      ) => {

        return (
          '<div class="math-block">' +
          '<code>' +
          escapeHtml(
            formula.trim()
          ) +
          '</code>' +
          '</div>'
        );
      }
    );


  html =
    html.replace(
      /\\\[([\s\S]*?)\\\]/g,
      (
        match,
        formula
      ) => {

        return (
          '<div class="math-block">' +
          '<code>' +
          escapeHtml(
            formula.trim()
          ) +
          '</code>' +
          '</div>'
        );
      }
    );


  return (
    html ||
    '<p></p>'
  );
}




// =========================================================
// ADD MESSAGE ROW
// =========================================================

function addRow(
  role,
  attachment,
  timestamp
){

  const empty =
    document.getElementById(
      'empty-state'
    );


  if(empty)
    empty.remove();


  const row =
    document.createElement(
      'div'
    );


  row.className =
    'row ' + role;


  const avatar =
    document.createElement(
      'div'
    );


  avatar.className =
    'avatar ' + role;


  if(
    role === 'user' &&
    userProfile
  ){

    const img =
      document.createElement(
        'img'
      );

    img.src =
      userProfile.picture ||
      DUMMY_AVATAR;

    img.alt = '';

    avatar.appendChild(
      img
    );

  }else if(
    role === 'user'
  ){

    avatar.textContent =
      'K';

  }else{

    avatar.textContent =
      'T';

  }


  const col =
    document.createElement(
      'div'
    );


  col.className =
    'bubble-col';


  const wrap =
    document.createElement(
      'div'
    );


  wrap.className =
    'bubble-wrap';


  const bubble =
    document.createElement(
      'div'
    );


  bubble.className =
    'bubble';


  // IMAGE

  if(
    attachment &&
    attachment.kind === 'image'
  ){

    const img =
      document.createElement(
        'img'
      );


    img.className =
      'msg-image';


    img.src =
      attachment.dataUrl;


    img.alt =
      attachment.name;


    img.title =
      attachment.name;


    bubble.appendChild(
      img
    );

  }


  // TEXT FILE

  else if(
    attachment &&
    attachment.kind === 'text'
  ){

    const chip =
      document.createElement(
        'div'
      );


    chip.className =
      'msg-file-chip';


    chip.innerHTML =

      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +

      '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +

      '<path d="M14 2v6h6"/>' +

      '</svg>' +

      '<span></span>';


    chip
      .querySelector('span')
      .textContent =
      attachment.name;


    bubble.appendChild(
      chip
    );

  }


  wrap.appendChild(
    bubble
  );


  if(role === 'ai'){

    const copyBtn =
      document.createElement(
        'button'
      );


    copyBtn.className =
      'copy-btn';


    copyBtn.textContent =
      '⧉';


    copyBtn.title =
      'Salin pesan';


    copyBtn.addEventListener(
      'click',
      () =>
        copyText(
          bubble.textContent,
          copyBtn
        )
    );


    wrap.appendChild(
      copyBtn
    );

  }


  const meta =
    document.createElement(
      'div'
    );


  meta.className =
    'meta';


  meta.textContent =
    timestamp ||
    timeNow();


  col.appendChild(
    wrap
  );


  col.appendChild(
    meta
  );


  row.appendChild(
    avatar
  );


  row.appendChild(
    col
  );


  messagesEl.appendChild(
    row
  );


  messagesEl.scrollTop =
    messagesEl.scrollHeight;


  return bubble;

}


// =========================================================
// LOAD CHAT HISTORY
// =========================================================

async function loadChatHistory(
  conversationId
){

  const idToken =
    localStorage.getItem(
      'id_token'
    );


  if(
    !idToken ||
    !conversationId
  )
    return;


  try{

    const response =
      await fetch(
        '/api/memories?conversationId=' +
        encodeURIComponent(
          conversationId
        ),
        {
          headers:{
            'Authorization':
              'Bearer ' + idToken
          }
        }
      );


    if(!response.ok)
      return;


    const data =
      await response.json();


    const chatHistory =
      Array.isArray(
        data.chatHistory
      )
      ? data.chatHistory
      : [];


    if(
      chatHistory.length === 0
    )
      return;


    const empty =
      document.getElementById(
        'empty-state'
      );


    if(empty)
      empty.remove();


    for(
      const msg of chatHistory
    ){

      const role =
        msg.role === 'user'
          ? 'user'
          : 'ai';


      const ts =
        msg.created_at

          ? new Date(
              msg.created_at
            ).toLocaleTimeString(
              'id-ID',
              {
                hour:'2-digit',
                minute:'2-digit'
              }
            )

          : undefined;


      const bubble =
        addRow(
          role,
          null,
          ts
        );


      if(role === 'ai'){

        bubble.innerHTML =
          renderMarkdown(
            msg.content
          );

      }else{

        const span =
          document.createElement(
            'span'
          );

        span.textContent =
          msg.content;

        bubble.appendChild(
          span
        );

      }


      history.push({

        role:
          msg.role === 'user'
            ? 'user'
            : 'assistant',

        content:
          msg.content

      });

    }


    messagesEl.scrollTop =
      messagesEl.scrollHeight;


  }catch(e){

    console.error(
      'Gagal memuat riwayat percakapan:',
      e
    );

  }

}


// =========================================================
// SILENT REAUTH
// =========================================================

function trySilentReauthThenRetry(
  onSuccess,
  onFail
){

  let settled = false;


  google.accounts.id.initialize({

    client_id:
      GOOGLE_CLIENT_ID,

    auto_select: false,

    callback:
      (response) => {

        settled = true;

        handleCredentialResponse(
          response
        );

        onSuccess();

      }

  });


  google.accounts.id.prompt(
    (notification) => {

      if(
        !settled &&
        (
          notification.isNotDisplayed() ||
          notification.isSkippedMoment()
        )
      ){

        onFail();

      }

    }
  );


  setTimeout(
    () => {

      if(!settled)
        onFail();

    },
    3000
  );

}


// =========================================================
// TRIM HISTORY SEBELUM DIKIRIM KE SERVER (HEMAT TOKEN)
// =========================================================
//
// `history` lokal terus bertambah selama sesi chat berjalan, dan
// sebelumnya SELURUH isinya (termasuk isi dokumen mentah & data
// gambar base64 dari pesan-pesan lama) dikirim ulang ke /api/chat
// di SETIAP pesan baru. Ini boros bandwidth & token Groq, karena
// isi dokumen/gambar yang sudah pernah dianalisis ikut terkirim
// ulang berkali-kali di setiap giliran chat berikutnya.
//
// Fungsi ini TIDAK mengubah `history` asli (supaya scrollback di
// UI dan apa yang tersimpan secara lokal tetap utuh) — ia hanya
// membuat salinan yang dipangkas untuk dikirim ke server. Backend
// (/api/chat) juga sudah punya safety net serupa, tapi memangkas
// di sini mengurangi ukuran request itu sendiri sebelum terkirim.

const FRONTEND_MAX_HISTORY_FOR_SEND = 16;
const FRONTEND_MAX_DOCS_FULL = 1;
const FRONTEND_MAX_IMAGE_MSGS_FULL = 1;


function historyMessageHasImage(msg){

  return (
    Array.isArray(msg.content) &&
    msg.content.some(
      p => p && p.type === 'image_url'
    )
  );

}


function historyMessageHasDocument(msg){

  return (
    typeof msg.content === 'string' &&
    (
      msg.content.includes('[Isi file') ||
      msg.content.includes('[File "')
    )
  );

}


function trimHistoryForSend(
  fullHistory
){

  const imageIdx = [];

  const docIdx = [];


  fullHistory.forEach(
    (m, i) => {

      if(
        historyMessageHasImage(m)
      ){
        imageIdx.push(i);
      }


      if(
        historyMessageHasDocument(m)
      ){
        docIdx.push(i);
      }

    }
  );


  const imageStrip =
    new Set(
      imageIdx.slice(
        0,
        Math.max(
          0,
          imageIdx.length -
          FRONTEND_MAX_IMAGE_MSGS_FULL
        )
      )
    );


  const docStrip =
    new Set(
      docIdx.slice(
        0,
        Math.max(
          0,
          docIdx.length -
          FRONTEND_MAX_DOCS_FULL
        )
      )
    );


  let trimmed =
    fullHistory.map(
      (m, i) => {

        if(
          imageStrip.has(i)
        ){

          const textPart =
            Array.isArray(m.content)
              ? m.content.find(
                  p => p.type === 'text'
                )
              : null;


          const label =
            (
              textPart &&
              textPart.text
            ) ||
            '(Lihat gambar terlampir)';


          return {

            role:
              m.role,

            content:
              label +
              '\n\n[Catatan: gambar pada pesan ini sudah pernah ' +
              'dianalisis sebelumnya di percakapan ini. Data gambar ' +
              'tidak dikirim ulang untuk menghemat token.]'

          };

        }


        if(
          docStrip.has(i)
        ){

          const match =
            m.content.match(
              /\[Isi file "([^"]+)"\]/i
            ) ||
            m.content.match(
              /\[File "([^"]+)"\]/i
            );


          const fileName =
            match
              ? match[1]
              : 'dokumen';


          return {

            role:
              m.role,

            content:
              `[Dokumen "${fileName}" sudah pernah diupload dan ` +
              `dianalisis sebelumnya di percakapan ini. Isi ` +
              `lengkapnya tidak dikirim ulang untuk menghemat ` +
              `token. Jika perlu detail dari dokumen ini lagi, ` +
              `minta user upload ulang.]`

          };

        }


        return m;

      }
    );


  if(
    trimmed.length >
    FRONTEND_MAX_HISTORY_FOR_SEND
  ){

    trimmed =
      trimmed.slice(
        trimmed.length -
        FRONTEND_MAX_HISTORY_FOR_SEND
      );

  }


  return trimmed;

}

// =========================================================
// GENERATE IMAGE
// =========================================================

function isImageGenerationRequest(text) {

  const t = text.toLowerCase().trim();

  return (
    t.startsWith('buatkan gambar') ||
    t.startsWith('buat gambar') ||
    t.startsWith('generate gambar') ||
    t.startsWith('hasilkan gambar') ||
    t.startsWith('bikin gambar') ||
    t.includes('buatkan ilustrasi') ||
    t.includes('buat ilustrasi')
  );

}


async function generateImage(prompt) {

  const idToken =
    localStorage.getItem('id_token');

  if (!idToken) {
    throw new Error('Sesi login sudah habis.');
  }

  const response =
    await fetch('/api/generate-image', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },

      body: JSON.stringify({
        prompt: prompt
      })
    });

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {

    throw new Error(
      data?.error ||
      'Gagal membuat gambar.'
    );

  }

  if (!data.image) {
    throw new Error(
      'Server tidak mengembalikan gambar.'
    );
  }

  return data.image;

}

async function sendImageGeneration(prompt) {

  const idToken =
    localStorage.getItem('id_token');

  if (!idToken) {

    alert(
      'Sesi login sudah habis. Silakan login kembali.'
    );

    return;

  }

  input.value = '';
  updateSendButton();

  input.style.height = 'auto';

  sendBtn.disabled = true;


  // Tampilkan pesan user
  addRow(
    'user',
    null
  ).appendChild(

    Object.assign(
      document.createElement('span'),
      {
        textContent: prompt
      }
    )

  );


  // Bubble AI
  const aiBubble =
    addRow('ai');


  aiBubble.innerHTML =
    '<span class="typing-dots">' +
      '<span></span>' +
      '<span></span>' +
      '<span></span>' +
    '</span>';


  try {

    const image =
      await generateImage(prompt);


    aiBubble.innerHTML = '';


    const img =
      document.createElement('img');


    img.className =
      'msg-image';


    img.src =
      image;


    img.alt =
      prompt;


    img.style.maxWidth =
      '100%';


    img.style.borderRadius =
      '14px';


    aiBubble.appendChild(
      img
    );


  } catch (error) {

    console.error(
      'Generate image error:',
      error
    );


    aiBubble.textContent =
      error.message ||
      'Gagal membuat gambar.';


  } finally {

    sendBtn.disabled = false;

    input.focus();

  }

}


// function percakapan ai 2 arah
// =========================================================
// START VOICE - GROQ WHISPER + AI + SPEECH
// =========================================================

let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceRecording = false;
let voiceProcessing = false;
let aiSpeaking = false;


// =========================================================
// START / STOP RECORDING
// =========================================================

async function toggleStartVoice(){

  if(voiceProcessing){
    return;
  }

  // Kalau sedang merekam → STOP
  if(voiceRecording){
    stopStartVoice();
    return;
  }

  const idToken =
    localStorage.getItem('id_token');

  if(!idToken){
    alert(
      'Sesi login sudah habis. Silakan login ulang dengan Google.'
    );
    return;
  }

  if(
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ){
    alert(
      'Browser tidak mendukung akses microphone.'
    );
    return;
  }

  try{

    voiceStream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

    voiceChunks = [];

    let mimeType = '';

    if(
      MediaRecorder.isTypeSupported(
        'audio/webm;codecs=opus'
      )
    ){
      mimeType =
        'audio/webm;codecs=opus';
    }
    else if(
      MediaRecorder.isTypeSupported(
        'audio/webm'
      )
    ){
      mimeType =
        'audio/webm';
    }
    else if(
      MediaRecorder.isTypeSupported(
        'audio/ogg;codecs=opus'
      )
    ){
      mimeType =
        'audio/ogg;codecs=opus';
    }

    voiceRecorder =
      mimeType
        ? new MediaRecorder(
            voiceStream,
            { mimeType }
          )
        : new MediaRecorder(
            voiceStream
          );


    // =====================================================
    // DATA AUDIO
    // =====================================================

    voiceRecorder.ondataavailable =
      (event) => {

        if(
          event.data &&
          event.data.size > 0
        ){
          voiceChunks.push(
            event.data
          );
        }

      };


    // =====================================================
    // RECORDING SELESAI
    // =====================================================

    voiceRecorder.onstop =
      async () => {

        try{

          const actualMime =
            voiceRecorder.mimeType ||
            mimeType ||
            'audio/webm';

          const audioBlob =
            new Blob(
              voiceChunks,
              {
                type: actualMime
              }
            );

          // Matikan microphone
          if(voiceStream){

            voiceStream
              .getTracks()
              .forEach(
                track => track.stop()
              );

          }

          voiceStream = null;
          voiceRecorder = null;
          voiceChunks = [];

          await processVoiceAudio(
            audioBlob
          );

        }catch(error){

          console.error(
            'Voice processing error:',
            error
          );

          resetVoiceButton();

          alert(
            'Gagal memproses suara.'
          );

        }

      };


    voiceRecorder.start();

    voiceRecording = true;

    startVoiceBtn.classList.add(
      'recording'
    );

    startVoiceBtn.title =
      'Stop Voice';

    startVoiceBtn.setAttribute(
      'aria-label',
      'Stop Voice'
    );

    console.log(
      'Voice recording started.'
    );

  }catch(error){

    console.error(
      'Microphone error:',
      error
    );

    if(
      error.name ===
      'NotAllowedError'
    ){

      alert(
        'Akses microphone ditolak. Izinkan microphone pada browser.'
      );

    }else{

      alert(
        'Tidak dapat mengakses microphone.'
      );

    }

  }

}

const startVoiceDefaultIcon =
  startVoiceBtn ? startVoiceBtn.innerHTML : '';

function setAIVoiceButtonSpeaking(active) {

  if (!startVoiceBtn) return;

  aiSpeaking = active;

  if (active) {

    startVoiceBtn.style.display = 'flex';

    startVoiceBtn.innerHTML = `
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="currentColor"
        aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="2"></rect>
      </svg>
    `;

    startVoiceBtn.classList.add('speaking');

    startVoiceBtn.title = 'Stop AI Voice';

    startVoiceBtn.setAttribute(
      'aria-label',
      'Stop AI Voice'
    );

  } else {

    startVoiceBtn.innerHTML =
      startVoiceDefaultIcon;

    startVoiceBtn.classList.remove(
      'speaking'
    );

    startVoiceBtn.title =
      'Start Voice';

    startVoiceBtn.setAttribute(
      'aria-label',
      'Start Voice'
    );

  }

  updateSendButton();
}


// =========================================================
// STOP RECORDING
// =========================================================

function stopStartVoice(){

  if(
    !voiceRecorder ||
    voiceRecorder.state === 'inactive'
  ){
    return;
  }

  voiceRecording = false;

  startVoiceBtn.classList.remove(
    'recording'
  );

  startVoiceBtn.classList.add(
    'processing'
  );

  startVoiceBtn.title =
    'Processing...';

  startVoiceBtn.setAttribute(
    'aria-label',
    'Processing voice'
  );

  voiceRecorder.stop();

}


// =========================================================
// PROCESS AUDIO
// =========================================================

async function processVoiceAudio(
  audioBlob
){

  voiceProcessing = true;

  try{

    if(!audioBlob || audioBlob.size === 0){

      throw new Error(
        'Audio kosong.'
      );

    }

    const idToken =
      localStorage.getItem(
        'id_token'
      );

    if(!idToken){

      throw new Error(
        'Sesi login sudah habis.'
      );

    }


    console.log(
      'Mengirim audio ke /api/voice:',
      audioBlob.size,
      'bytes'
    );


    // ===================================================
    // KIRIM KE BACKEND
    // ===================================================

    const response =
      await fetch(
        '/api/voice',
        {
          method: 'POST',

          headers: {
            'Authorization':
              'Bearer ' + idToken,

            'Content-Type':
              audioBlob.type ||
              'audio/webm'
          },

          body: audioBlob
        }
      );


    // ===================================================
    // BACA RESPONSE
    // ===================================================

    let data = {};

    try{

      data =
        await response.json();

    }catch(e){

      throw new Error(
        'Response dari server tidak valid.'
      );

    }


    if(response.status === 401){

      throw new Error(
        'Sesi login sudah habis. Silakan login ulang.'
      );

    }


    if(!response.ok){

      throw new Error(
        data.error ||
        'Voice API gagal.'
      );

    }


    const userText =
      (data.text || '').trim();

    const answer =
      (data.answer || '').trim();


    if(!userText){

      throw new Error(
        'Suara tidak berhasil dikenali.'
      );

    }


    // ===================================================
    // TAMPILKAN USER MESSAGE
    // ===================================================

    addRow(
      'user',
      null
    )
    .appendChild(
      Object.assign(
        document.createElement(
          'span'
        ),
        {
          textContent:
            userText
        }
      )
    );


    // ===================================================
    // SIMPAN KE HISTORY
    // ===================================================

    history.push({
      role: 'user',
      content: userText
    });


    // ===================================================
    // TAMPILKAN AI
    // ===================================================

    const aiRow =
      addRow(
        'assistant',
        null
      );

    const aiBubble =
      aiRow.querySelector(
        '.bubble'
      );


    if(aiBubble){

      aiBubble.innerHTML =
        typeof renderMarkdown ===
        'function'
          ? renderMarkdown(answer)
          : '';

      if(
        !aiBubble.innerHTML
      ){

        aiBubble.textContent =
          answer;

      }

    }


    // ===================================================
    // SIMPAN AI KE HISTORY
    // ===================================================

    if(answer){

      history.push({
        role: 'assistant',
        content: answer
      });

    }
    
    // ===================================================
    // SCROLL
    // ===================================================

    messagesEl.scrollTop =
      messagesEl.scrollHeight;


    // ===================================================
    // BACA JAWABAN DENGAN SUARA
    // ===================================================

    speakVoiceAnswer(
      answer
    );


  }catch(error){

    console.error(
      'VOICE API ERROR:',
      error
    );

    alert(
      error?.message ||
      'Terjadi kesalahan pada Voice Mode.'
    );

  }finally{

    voiceProcessing = false;

    resetVoiceButton();

  }

}


// =========================================================
// TEXT TO SPEECH
// =========================================================

function cleanTextForSpeech(text) {

  if (!text) return '';

  return text

    // Code block
    .replace(/```[\s\S]*?```/g, '')

    // Inline code
    .replace(/`([^`]+)`/g, '$1')

    // Bold / italic
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')

    // Heading
    .replace(/^#{1,6}\s+/gm, '')

    // Bullet
    .replace(/^\s*[-*+]\s+/gm, '')

    // Numbered list
    .replace(/^\s*\d+\.\s+/gm, '')

    // Blockquote
    .replace(/^\s*>\s?/gm, '')

    // Link markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Horizontal line
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')

    // Sisa karakter Markdown
    .replace(/[*_~#`>|]/g, '')

    // Rapikan spasi
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}


function speakVoiceAnswer(text) {

  if (
    !text ||
    !('speechSynthesis' in window)
  ) {
    return;
  }

  try {

    window.speechSynthesis.cancel();

    const cleanText =
      cleanTextForSpeech(text);

    if (!cleanText) return;

    const utterance =
      new SpeechSynthesisUtterance(
        cleanText
      );

    utterance.lang = 'id-ID';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    utterance.onstart = function () {
      setAIVoiceButtonSpeaking(true);
    };

    utterance.onend = function () {
      setAIVoiceButtonSpeaking(false);
    };

    utterance.onerror = function () {
      setAIVoiceButtonSpeaking(false);
    };

    window.speechSynthesis.speak(
      utterance
    );

  } catch (error) {

    console.error(
      'Text-to-speech error:',
      error
    );

    setAIVoiceButtonSpeaking(false);
  }
}


// =========================================================
// RESET BUTTON
// =========================================================

function resetVoiceButton(){

  voiceRecording = false;
  voiceProcessing = false;

  if(startVoiceBtn){

    startVoiceBtn.classList.remove(
      'recording',
      'processing'
    );

    startVoiceBtn.title =
      'Start Voice';

    startVoiceBtn.setAttribute(
      'aria-label',
      'Start Voice'
    );

  }

}


// =========================================================
// BUTTON EVENT
// =========================================================

// if(startVoiceBtn){

//   startVoiceBtn.addEventListener(
//     'click',
//     toggleStartVoice
//   );

// }

if (startVoiceBtn) {

  startVoiceBtn.addEventListener(
    'click',
    function () {

      // AI sedang bicara → tombol menjadi STOP
      if (aiSpeaking) {

        window.speechSynthesis.cancel();

        setAIVoiceButtonSpeaking(false);

        return;
      }

      // Normal → Voice Mode
      toggleStartVoice();

    }
  );

}


// =========================================================
// SEND MESSAGE
// =========================================================

async function sendMessage(){

  const text =
    input.value.trim();

  if (!text && !pendingAttachment) {
    return;
  }


  const attachment =
    pendingAttachment;


  // if(
  //   !text &&
  //   !attachment
  // )
  //   return;

   if (
    text &&
    !attachment &&
    isImageGenerationRequest(text)
  ) {

    await sendImageGeneration(text);

    return;

  }


  const idToken =
    localStorage.getItem(
      'id_token'
    );


  if(!idToken){

    alert(
      'Sesi login sudah habis. Silakan login ulang dengan Google.'
    );


    document.getElementById(
      'chat-screen'
    ).style.display =
      'none';


    document.getElementById(
      'login-screen'
    ).style.display =
      'flex';


    return;

  }


  input.value = '';
  updateSendButton();
  

  input.style.height =
    'auto';


  clearAttachment();


  sendBtn.disabled =
    true;


  // USER BUBBLE

  addRow(
    'user',
    attachment
  ).appendChild(

    Object.assign(
      document.createElement(
        'span'
      ),
      {
        textContent:
          text
      }
    )

  );


  // MESSAGE CONTENT

  let messageContent;


  if(
    attachment &&
    attachment.kind === 'image'
  ){

    messageContent = [

      {
        type:'text',

        text:
          text ||
          '(Lihat gambar terlampir)'

      },

      {
        type:'image_url',

        image_url:{
          url:
            attachment.dataUrl
        }

      }

    ];

  }

  else if(
    attachment &&
    attachment.kind === 'text'
  ){

    const notice =
      attachment.truncated

        ? '\n\n[File "' +
          attachment.name +
          '" dipotong karena terlalu panjang]\n---\n'

        : '\n\n[Isi file "' +
          attachment.name +
          '"]\n---\n';


    messageContent =
      (
        text
          ? text
          : 'Tolong lihat isi file berikut:'
      ) +

      notice +

      attachment.text;

  }

  else{

    messageContent =
      text;

  }


  history.push({

    role:'user',

    content:
      messageContent

  });


  // AI BUBBLE

  const aiBubble =
    addRow('ai');


  aiBubble.innerHTML =

    '<span class="typing-dots">' +

      '<span></span>' +
      '<span></span>' +
      '<span></span>' +

    '</span>';


  let fullText = '';


  const isNewConversation =
    currentConversationId === null;


  try{

    const response =
      await fetch(
        '/api/chat',
        {

          method:'POST',

          headers:{

            'Content-Type':
              'application/json',

            'Authorization':
              'Bearer ' + idToken

          },

          body:
            JSON.stringify({

              messages:
                trimHistoryForSend(
                  history
                ),

              conversationId:
                currentConversationId

            })

        }
      );


    // CONVERSATION ID

    const convIdHeader =
      response.headers.get(
        'X-Conversation-Id'
      );


    if(convIdHeader){

      currentConversationId =
        Number(
          convIdHeader
        );

    }

    // ============================================================
    // CHAT LIMIT / RATE LIMIT
    // ============================================================
    if(response.status === 429){
    
      aiBubble.textContent =
        'Limit Chat sudah habis. Silakan coba lagi beberapa saat lagi.';
    
      sendBtn.disabled = false;
    
      return;
    }

    // 401
    // ============================================================
    // 401 = SESSION BENAR-BENAR TIDAK VALID
    // ============================================================
    if(response.status === 401){
    
      let errorMessage = '';
    
      try{
        const data = await response.json();
    
        errorMessage =
          data?.error ||
          data?.message ||
          '';
      }catch(e){}
    
      console.error(
        'API 401:',
        errorMessage
      );
    
      // Hanya anggap session habis jika backend memang
      // mengirim pesan unauthorized/session.
      const isSessionError =
        /unauthorized|session|token|login|expired|kedaluwarsa/i
          .test(errorMessage);
    
      if(!isSessionError){
    
        aiBubble.textContent =
          errorMessage ||
          'Terjadi error pada server AI.';
    
        sendBtn.disabled = false;
    
        return;
      }
    
      // Memang session invalid
      aiBubble.textContent =
        'Sesi login sudah habis. Silakan login kembali.';
    
      localStorage.removeItem('id_token');
    
      setTimeout(() => {
    
        document.getElementById(
          'chat-screen'
        ).style.display = 'none';
    
        document.getElementById(
          'login-screen'
        ).style.display = 'flex';
    
      }, 1200);
    
      return;
    }
    // if(
    //   response.status === 401
    // ){

    //   aiBubble.innerHTML =

    //     '<span class="typing-dots">' +

    //       '<span></span>' +
    //       '<span></span>' +
    //       '<span></span>' +

    //     '</span>';


    //   trySilentReauthThenRetry(

    //     () => {

    //       sendBtn.disabled =
    //         false;

    //       aiBubble
    //         .closest('.row')
    //         .remove();

    //       sendMessage();

    //     },

    //     () => {

    //       aiBubble.textContent =
    //         'Sesi login sudah habis. Silakan login ulang.';


    //       localStorage.removeItem(
    //         'id_token'
    //       );


    //       setTimeout(
    //         () => {

    //           document.getElementById(
    //             'chat-screen'
    //           ).style.display =
    //             'none';


    //           document.getElementById(
    //             'login-screen'
    //           ).style.display =
    //             'flex';

    //         },
    //         1200
    //       );

    //     }

    //   );


    //   return;

    // }


    // ERROR
    if(
      !response.ok ||
      !response.body
    ){
    
      let errorMessage =
        'Maaf, AI sedang tidak bisa dihubungi. Silakan coba lagi beberapa saat lagi.';
    
      try{
        const data =
          await response.json();
    
        if(data && data.error){
          errorMessage =
            data.error;
        }
      }catch(e){}
    
      aiBubble.textContent =
        errorMessage;
    
      sendBtn.disabled = false;
    
      return;
    }


    // STREAM

    const reader =
      response.body.getReader();


    const decoder =
      new TextDecoder();


    let buffer = '';

    let started = false;


    while(true){

      const {
        done,
        value
      } =
        await reader.read();


      if(done)
        break;


      buffer +=
        decoder.decode(
          value,
          {
            stream:true
          }
        );


      const parts =
        buffer.split(
          '\n\n'
        );


      buffer =
        parts.pop();


      for(
        const part of parts
      ){

        const lines =
          part.split('\n');


        const dataLine =
          lines.find(
            l =>
              l.startsWith(
                'data:'
              )
          );


        if(!dataLine)
          continue;


        const raw =
          dataLine
            .slice(5)
            .trim();


        if(
          !raw ||
          raw === '[DONE]'
        )
          continue;


        try{

          const json =
            JSON.parse(
              raw
            );


          const choice =
            json.choices &&
            json.choices[0];


          const chunkText =
            choice &&
            choice.delta &&
            choice.delta.content;


          if(chunkText){

            started = true;


            const stayPinned =
              isNearBottom();


            fullText +=
              chunkText;


            aiBubble.innerHTML =
              renderMarkdown(
                fullText
              );

            if(
              window.MathJax &&
              MathJax.typesetPromise
            ){
              MathJax.typesetPromise([
                aiBubble
              ]).catch(
                console.error
              );
            }


            if(stayPinned){

              messagesEl.scrollTop =
                messagesEl.scrollHeight;

            }

          }


          const finishReason =
            choice &&
            choice.finish_reason;


          if(
            finishReason &&
            finishReason !== 'stop' &&
            !chunkText &&
            !started
          ){

            aiBubble.textContent =
              'Respons berhenti (alasan: ' +
              finishReason +
              ').';

            started = true;

          }


        }catch(e){

          // Abaikan baris non-JSON

        }

      }

    }


    // SAVE AI HISTORY

    if(fullText){

      history.push({

        role:'assistant',

        content:
          fullText

      });

    }

    else if(!started){

      aiBubble.textContent =
        'Tidak ada balasan diterima. Coba lagi.';

    }


    // REFRESH SIDEBAR

    if(
      isNewConversation &&
      currentConversationId !== null
    ){

      loadConversations(
        false
      );

    }


  }catch(e){

    console.error(
      'Chat error:',
      e
    );


    aiBubble.textContent =
      'Tidak bisa terhubung ke AI. Periksa koneksi lalu coba lagi.';

  }finally{

    sendBtn.disabled =
      false;

  }

}


// =========================================================
// SEND BUTTON
// =========================================================

sendBtn.addEventListener(
  'click',
  sendMessage
);


// =========================================================
// ENTER TO SEND
// =========================================================

input.addEventListener(
  'keydown',
  (e) => {

    if(
      e.key === 'Enter' &&
      !e.shiftKey
    ){

      e.preventDefault();

      sendMessage();

    }

  }
);


/* =========================================================
   SIDEBAR RESPONSIVE + MANUAL RESIZE
   ========================================================= */

(() => {
  const chatBody = document.getElementById("chat-body");
  const sidebar = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const backdrop = document.getElementById("sidebar-backdrop");

  if (!chatBody || !sidebar) return;

  const MIN_WIDTH = 220;
  const MAX_WIDTH = 480;
  const MOBILE_BREAKPOINT = 700;

  let isResizing = false;

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  /* -----------------------------------------
     Toggle sidebar
     ----------------------------------------- */

  function toggleSidebar() {
    if (isMobile()) {
      chatBody.classList.toggle("sidebar-open");
    } else {
      chatBody.classList.toggle("sidebar-collapsed");
    }
  }

  function closeSidebarMobile() {
    if (isMobile()) {
      chatBody.classList.remove("sidebar-open");
    }
  }

  toggleBtn?.addEventListener("click", toggleSidebar);

  backdrop?.addEventListener("click", closeSidebarMobile);

  /* -----------------------------------------
     Manual resize
     ----------------------------------------- */

  sidebar.addEventListener("pointerdown", (event) => {

    if (isMobile()) return;

    const rect = sidebar.getBoundingClientRect();

    /* Hanya aktif kalau klik area kanan sidebar */
    if (event.clientX < rect.right - 12) return;

    isResizing = true;

    sidebar.setPointerCapture?.(event.pointerId);

    document.body.classList.add("sidebar-resizing");

    event.preventDefault();
  });

  document.addEventListener("pointermove", (event) => {

    if (!isResizing) return;

    let width = event.clientX;

    width = Math.max(MIN_WIDTH, width);
    width = Math.min(MAX_WIDTH, width);

    chatBody.style.setProperty("--sidebar-width", `${width}px`);
  });

  document.addEventListener("pointerup", () => {

    if (!isResizing) return;

    isResizing = false;

    document.body.classList.remove("sidebar-resizing");

    /* Simpan ukuran sidebar */
    const width = parseInt(
      getComputedStyle(chatBody)
        .getPropertyValue("--sidebar-width")
    );

    if (width) {
      localStorage.setItem("tanya_sidebar_width", width);
    }
  });

  /* -----------------------------------------
     Load ukuran sidebar terakhir
     ----------------------------------------- */

  const savedWidth = localStorage.getItem("tanya_sidebar_width");

  if (savedWidth && !isNaN(savedWidth)) {

    const width = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, Number(savedWidth))
    );

    chatBody.style.setProperty(
      "--sidebar-width",
      `${width}px`
    );
  }

  /* -----------------------------------------
     Reset mobile state saat resize window
     ----------------------------------------- */

  window.addEventListener("resize", () => {

    if (!isMobile()) {
      chatBody.classList.remove("sidebar-open");
    }
  });

})();


// =========================================================
// VOICE INPUT — SPEECH TO TEXT
// =========================================================

(() => {
  const voiceBtn = document.getElementById("voice-btn");
  const input = document.getElementById("chat-input");

  if (!voiceBtn || !input) return;

  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceBtn.style.display = "none";
    console.warn("Browser tidak mendukung Speech Recognition.");
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = "id-ID";
  recognition.continuous = false;
  recognition.interimResults = true;

  let recording = false;

  voiceBtn.addEventListener("click", () => {
    if (recording) {
      recognition.stop();
      return;
    }

    try {
      recognition.start();
    } catch (error) {
      console.error("Voice start error:", error);
    }
  });

  recognition.onstart = () => {
    recording = true;
    voiceBtn.classList.add("recording");
    voiceBtn.title = "Berhenti merekam";
  };

  recognition.onresult = (event) => {
    let transcript = "";

    for (
      let i = event.resultIndex;
      i < event.results.length;
      i++
    ) {
      transcript += event.results[i][0].transcript;
    }

    if (transcript.trim()) {
      input.value = transcript.trim();

      input.dispatchEvent(new Event("input", {
        bubbles: true
      }));
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
  };

  recognition.onend = () => {
    recording = false;
    voiceBtn.classList.remove("recording");
    voiceBtn.title = "Bicara dengan Tanya";
  };
})();

// =========================================================
// PROJECTS
// =========================================================

async function loadProjects() {
  const idToken = localStorage.getItem("id_token");
  const projectList = document.getElementById("sidebar-project-list");

  if (!projectList) return;

  // Belum login
  if (!idToken) {
    projectList.innerHTML = "";
    return;
  }

  // Loading
  projectList.innerHTML = `
    <div class="project-loading">
      Memuat project...
    </div>
  `;

  try {
    const response = await fetch("/api/projects", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${idToken}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Gagal mengambil project"
      );
    }

    // Bersihkan daftar lama
    projectList.innerHTML = "";

    // Tidak ada project
    if (!Array.isArray(data.projects) || data.projects.length === 0) {
      projectList.innerHTML = `
        <div class="project-empty">
          Belum ada project
        </div>
      `;
      return;
    }

    // Render project
    data.projects.forEach((project) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "project-item";
      button.dataset.projectId = project.id;

      button.innerHTML = `
        <span class="project-item-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
          </svg>
        </span>

        <span class="project-item-name"></span>
      `;

      // Lebih aman daripada innerHTML + escapeHtml()
      const nameElement =
        button.querySelector(".project-item-name");

      nameElement.textContent =
        project.name || "Untitled Project";

      button.addEventListener("click", () => {
        console.log(
          "Project dipilih:",
          project.id
        );

        // Nanti di sini kita load conversation
        // berdasarkan project.id
      });

      projectList.appendChild(button);
    });

  } catch (error) {
    console.error(
      "Load projects error:",
      error
    );

    projectList.innerHTML = `
      <div class="project-empty">
        Gagal memuat project
      </div>
    `;
  }
}

async function restoreSession() {

  const token =
    localStorage.getItem('id_token');

  if (!token) {
    return;
  }

  // Tampilkan halaman chat
  showChatScreen();

  // Muat ulang data dari database
  await loadConversations(true);
  await loadProjects(true);

  const input =
    document.getElementById('chat-input');

  if (input) {
    input.focus();
  }
}

async function createProject() {
  const idToken = localStorage.getItem('id_token');
  const name =
    prompt("Nama Project:");

  if (!name || !name.trim()) {
    return;
  }


  try {

    const response =
      await fetch("/api/projects", {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            'Bearer ' + idToken
        },

        body: JSON.stringify({
          name: name.trim()
        })
      });


    const data =
      await response.json();


    if (!response.ok || !data.success) {

      throw new Error(
        data.error ||
        "Gagal membuat project"
      );

    }


    await loadProjects();


  } catch (error) {

    console.error(
      "Create project error:",
      error
    );

    alert(
      error.message ||
      "Gagal membuat project"
    );

  }

}

const projectsBtn =
  document.getElementById(
    "projects-btn"
  );


if (projectsBtn) {

  projectsBtn.addEventListener(
    "click",
    createProject
  );

}

// =========================================================
// AUTO RESIZE TEXTAREA
// =========================================================

input.addEventListener(
  'input',
  () => {

    input.style.height =
      'auto';


    input.style.height =
      Math.min(
        input.scrollHeight,
        140
      ) + 'px';

  }
);
