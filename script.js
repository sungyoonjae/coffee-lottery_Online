/* 커피 제비뽑기 · 온라인 버전
 * - PeerJS(WebRTC)로 브라우저끼리 직접 연결합니다. 별도 서버가 필요 없습니다.
 * - 방장(Host)의 브라우저가 게임 판정을 담당합니다. 당첨 카드 위치는 방장 브라우저에만 있고,
 *   다른 참가자에게는 뒤집힌 카드의 결과만 전달됩니다.
 * - 방장이 창을 닫으면 방이 종료됩니다.
 */

const PREFIX = 'i3lab-coffee-lottery-v1-';
const TOTAL_CARDS = 25;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const safeEmojis = ['🥐', '🍩', '🍪', '🍰', '🧁', '🥨', '🍫', '🍮', '🥞', '🍯', '🥤', '🫖', '🍵', '🥛', '🍦'];
const buyerEmojis = ['☕', '💸', '🧾', '🫡', '😵', '🔥'];

const $ = sel => document.querySelector(sel);
const entryScreen = $('#entryScreen');
const roomScreen = $('#roomScreen');
const nameInput = $('#nameInput');
const roomCodeInput = $('#roomCodeInput');
const createBtn = $('#createBtn');
const joinBtn = $('#joinBtn');
const entryMsg = $('#entryMsg');
const roomCodeText = $('#roomCodeText');
const copyLinkBtn = $('#copyLinkBtn');
const leaveBtn = $('#leaveBtn');
const playersEl = $('#players');
const hostPanel = $('#hostPanel');
const buyerCountInput = $('#buyerCount');
const startBtn = $('#startBtn');
const skipBtn = $('#skipBtn');
const resetBtn = $('#resetBtn');
const statusTitle = $('#statusTitle');
const statusText = $('#statusText');
const foundCountEl = $('#foundCount');
const targetCountEl = $('#targetCount');
const board = $('#board');
const toast = $('#toast');
const modal = $('#resultModal');
const modalEmoji = $('#modalEmoji');
const modalTitle = $('#modalTitle');
const modalText = $('#modalText');
const closeModalBtn = $('#closeModalBtn');
const canvas = $('#confettiCanvas');
const ctx = canvas.getContext('2d');

let peer = null;
let isHost = false;
let myId = null;
let myName = '';
let hostConn = null;          // 참가자: 방장과의 연결
const conns = new Map();      // 방장: peerId -> 연결
let state = null;             // 모두가 공유하는 게임 상태
let secret = [];              // 방장 전용: 각 카드가 커피 사기인지
let renderedRound = -1;
let lastSeenEvent = -1;
let modalAction = null;
let confettiParticles = [];
let confettiAnimation = null;

/* ---------- 유틸 ---------- */
function shuffle(array) {
  const copied = [...array];
  for (let i = copied.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function makeCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function blankCards() {
  return Array.from({ length: TOTAL_CARDS }, () => ({ flipped: false }));
}

function playerName(id) {
  const p = state && state.players.find(player => player.id === id);
  return p ? p.name : '?';
}

function saveName(name) {
  try { localStorage.setItem('coffeeLotteryName', name); } catch (e) { /* 무시 */ }
}

function loadName() {
  try { return localStorage.getItem('coffeeLotteryName') || ''; } catch (e) { return ''; }
}

function setEntryMessage(text) {
  entryMsg.textContent = text;
  entryMsg.classList.toggle('hidden', !text);
}

function setEntryBusy(busy) {
  createBtn.disabled = busy;
  joinBtn.disabled = busy;
  createBtn.style.opacity = busy ? 0.6 : 1;
  joinBtn.style.opacity = busy ? 0.6 : 1;
}

/* ---------- 방장(Host) ---------- */
function createRoom(attempt = 0) {
  myName = cleanName(nameInput.value);
  if (!myName) { showToast('닉네임을 먼저 입력하세요.'); nameInput.focus(); return; }
  saveName(myName);
  setEntryBusy(true);
  setEntryMessage('방을 만드는 중...');

  const code = makeCode();
  peer = new Peer(PREFIX + code);

  peer.on('open', () => {
    isHost = true;
    myId = 'host';
    secret = [];
    state = {
      code,
      players: [{ id: 'host', name: myName, online: true, host: true }],
      phase: 'lobby',
      target: 1,
      round: 0,
      cards: blankCards(),
      order: [],
      turn: null,
      buyers: [],
      event: null,
      eventSeq: 0
    };
    enterRoom();
    hostBroadcast();
  });

  peer.on('connection', conn => {
    conn.on('data', msg => hostHandle(conn, msg));
    conn.on('close', () => hostPlayerLeft(conn.peer));
    conn.on('error', () => hostPlayerLeft(conn.peer));
  });

  peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });

  peer.on('error', err => {
    if (err.type === 'unavailable-id' && attempt < 5) {
      peer.destroy();
      createRoom(attempt + 1);
      return;
    }
    if (!state) {
      setEntryBusy(false);
      setEntryMessage('방을 만들지 못했어요. 인터넷 연결을 확인하고 다시 시도해주세요. (' + err.type + ')');
    }
  });
}

function hostEmit(event) {
  state.eventSeq += 1;
  state.event = { ...event, seq: state.eventSeq };
}

function hostBroadcast() {
  const payload = { t: 'state', state };
  conns.forEach(conn => { if (conn.open) conn.send(payload); });
  applyState(state);
}

function hostHandle(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = conn.peer;

  if (msg.t === 'join') {
    conns.set(id, conn);
    let name = cleanName(msg.name) || '손님';
    const taken = new Set(state.players.filter(p => p.id !== id && p.online).map(p => p.name));
    let finalName = name;
    let n = 2;
    while (taken.has(finalName)) { finalName = `${name}${n}`; n += 1; }

    const existing = state.players.find(p => p.id === id);
    if (existing) {
      existing.online = true;
      existing.name = finalName;
    } else {
      state.players.push({ id, name: finalName, online: true });
    }
    conn.send({ t: 'welcome', id });
    hostEmit({ kind: 'join', name: finalName });
    hostBroadcast();
    return;
  }

  if (msg.t === 'flip') hostFlip(id, Number(msg.index));
}

function hostPlayerLeft(id) {
  if (!conns.has(id)) return;
  conns.delete(id);
  const player = state.players.find(p => p.id === id);
  if (!player) return;

  if (state.phase === 'lobby') {
    state.players = state.players.filter(p => p.id !== id);
  } else {
    player.online = false;
  }

  const wasTurn = state.turn === id;
  const idx = state.order.indexOf(id);
  if (idx !== -1) state.order.splice(idx, 1);

  if (state.phase === 'playing' && wasTurn) {
    // 나간 사람이 순서에서 빠졌으므로 같은 위치(idx)가 다음 사람
    state.turn = nextTurnFrom(idx, true);
    if (!state.turn) finishEarly();
  }

  hostEmit({ kind: 'leave', name: player.name });
  hostBroadcast();
}

function isOnline(id) {
  const p = state.players.find(player => player.id === id);
  return Boolean(p && p.online);
}

// startIdx: 기준 위치. includeStart=true면 그 위치의 사람부터 검사
function nextTurnFrom(startIdx, includeStart) {
  const order = state.order;
  if (order.length === 0) return null;
  const base = Math.max(startIdx, 0);
  for (let step = includeStart ? 0 : 1; step <= order.length; step += 1) {
    const candidate = order[(base + step) % order.length];
    if (isOnline(candidate)) return candidate;
  }
  return null;
}

function finishEarly() {
  state.phase = 'done';
  state.turn = null;
}

function hostStart() {
  const online = state.players.filter(p => p.online);
  const target = Math.min(Math.max(Number.parseInt(buyerCountInput.value, 10) || 1, 1), online.length, TOTAL_CARDS);
  buyerCountInput.value = target;

  const buyerIndexes = new Set(shuffle([...Array(TOTAL_CARDS).keys()]).slice(0, target));
  secret = Array.from({ length: TOTAL_CARDS }, (_, i) => buyerIndexes.has(i));

  state.round += 1;
  state.target = target;
  state.phase = 'shuffling';
  state.cards = blankCards();
  state.order = shuffle(online.map(p => p.id));
  state.buyers = [];
  state.turn = null;
  // 다음 판에는 오프라인 참가자를 목록에서 정리
  state.players = state.players.filter(p => p.online);
  hostEmit({ kind: 'shuffle' });
  hostBroadcast();

  const round = state.round;
  setTimeout(() => {
    if (state.round !== round || state.phase !== 'shuffling') return;
    state.phase = 'playing';
    state.turn = nextTurnFrom(0, true);
    if (!state.turn) finishEarly();
    hostEmit({ kind: 'start', order: state.order.map(playerName) });
    hostBroadcast();
  }, 1400);
}

function hostFlip(id, index) {
  if (state.phase !== 'playing') return;
  if (state.turn !== id) return;
  if (!Number.isInteger(index) || index < 0 || index >= TOTAL_CARDS) return;
  if (state.cards[index].flipped) return;

  const isBuyer = secret[index];
  const name = playerName(id);
  state.cards[index] = {
    flipped: true,
    isBuyer,
    by: name,
    emoji: isBuyer ? buyerEmojis[index % buyerEmojis.length] : safeEmojis[index % safeEmojis.length]
  };

  const idx = state.order.indexOf(id);
  if (isBuyer) {
    state.buyers.push(id);
    state.order.splice(idx, 1);
  }

  let done = false;
  if (state.buyers.length >= state.target) {
    done = true;
    state.phase = 'done';
    state.turn = null;
  } else {
    // 당첨자는 순서에서 빠지므로 같은 위치(idx)가 다음 사람
    state.turn = isBuyer ? nextTurnFrom(idx, true) : nextTurnFrom(idx, false);
    if (!state.turn) { finishEarly(); done = true; }
  }

  hostEmit({ kind: 'flip', index, isBuyer, name, done });
  hostBroadcast();
}

function hostSkip() {
  if (state.phase !== 'playing' || !state.turn) return;
  const skipped = playerName(state.turn);
  const idx = state.order.indexOf(state.turn);
  state.turn = nextTurnFrom(idx, false);
  if (!state.turn) finishEarly();
  hostEmit({ kind: 'skip', name: skipped });
  hostBroadcast();
}

function hostReset() {
  state.round += 1;
  state.phase = 'lobby';
  state.cards = blankCards();
  state.order = [];
  state.buyers = [];
  state.turn = null;
  state.players = state.players.filter(p => p.online);
  secret = [];
  hostEmit({ kind: 'reset' });
  hostBroadcast();
}

/* ---------- 참가자(Guest) ---------- */
function joinRoom() {
  myName = cleanName(nameInput.value);
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!myName) { showToast('닉네임을 먼저 입력하세요.'); nameInput.focus(); return; }
  if (code.length !== 4) { showToast('4자리 방 코드를 입력하세요.'); roomCodeInput.focus(); return; }
  saveName(myName);
  setEntryBusy(true);
  setEntryMessage('방에 연결하는 중...');

  peer = new Peer();
  let opened = false;

  peer.on('open', () => {
    hostConn = peer.connect(PREFIX + code, { reliable: true });

    const timer = setTimeout(() => {
      if (!opened) failJoin('방에 연결하지 못했어요. 코드를 확인하거나, 회사·학교 네트워크라면 다른 네트워크(휴대폰 핫스팟 등)로 시도해보세요.');
    }, 12000);

    hostConn.on('open', () => {
      opened = true;
      clearTimeout(timer);
      hostConn.send({ t: 'join', name: myName });
    });

    hostConn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'welcome') {
        myId = msg.id;
        enterRoom();
      }
      if (msg.t === 'state' && myId) applyState(msg.state);
      if (msg.t === 'state' && !myId) { myId = peer.id; enterRoom(); applyState(msg.state); }
    });

    hostConn.on('close', () => {
      if (!opened) return;
      showModal({
        emoji: '👋',
        title: '방이 종료됐어요',
        text: '방장이 나갔거나 연결이 끊겼습니다.',
        button: '처음으로',
        action: () => location.href = location.pathname
      });
    });
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable') failJoin('해당 코드의 방을 찾을 수 없어요. 코드를 다시 확인해주세요.');
    else if (!opened) failJoin('연결 오류가 발생했어요. (' + err.type + ')');
  });
}

function failJoin(message) {
  if (peer) { peer.destroy(); peer = null; }
  setEntryBusy(false);
  setEntryMessage(message);
}

function sendFlip(index) {
  if (isHost) hostFlip('host', index);
  else if (hostConn && hostConn.open) hostConn.send({ t: 'flip', index });
}

/* ---------- 화면 ---------- */
function enterRoom() {
  if (!entryScreen.classList.contains('hidden')) {
    entryScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    hostPanel.classList.toggle('hidden', !isHost);
  }
}

function makeCards() {
  board.innerHTML = '';
  for (let index = 0; index < TOTAL_CARDS; index += 1) {
    const button = document.createElement('button');
    button.className = 'card';
    button.type = 'button';
    button.setAttribute('aria-label', `${index + 1}번 카드`);
    button.style.animationDelay = `${index * 22}ms`;
    button.innerHTML = `
      <span class="card-inner">
        <span class="face front">
          <span class="front-content">
            <span class="card-mark">☕</span>
            <span class="card-label">PICK ME</span>
          </span>
        </span>
        <span class="face back safe">
          <span class="back-content">
            <span class="card-mark">😋</span>
            <span class="card-label">커피 얻어먹기</span>
            <span class="card-by"></span>
          </span>
        </span>
      </span>
    `;
    button.addEventListener('click', () => onCardClick(index));
    board.appendChild(button);
  }
}

function onCardClick(index) {
  if (!state) return;
  if (state.phase === 'lobby') { showToast(isHost ? '먼저 카드 섞기를 눌러주세요.' : '방장이 카드를 섞을 때까지 기다려주세요.'); return; }
  if (state.phase === 'shuffling') return;
  if (state.phase === 'done') { showToast('이번 판은 끝났어요.'); return; }
  if (state.cards[index].flipped) return;
  if (state.turn !== myId) {
    const inOrder = state.order.includes(myId);
    showToast(inOrder ? `지금은 ${playerName(state.turn)}님 차례예요.` : '이번 판에는 참여하지 않아요. 다음 판을 기다려주세요.');
    return;
  }
  sendFlip(index);
}

function applyState(s) {
  const firstState = state === null || lastSeenEvent === -1;
  state = s;
  roomCodeText.textContent = s.code;

  if (s.round !== renderedRound) {
    makeCards();
    renderedRound = s.round;
    hideModal();
    stopConfetti();
  }

  const buttons = [...board.children];
  buttons.forEach((button, i) => {
    button.classList.toggle('shuffling', s.phase === 'shuffling');
    const card = s.cards[i];
    if (card.flipped && !button.classList.contains('flipped')) {
      const back = button.querySelector('.back');
      back.classList.toggle('buyer', card.isBuyer);
      back.classList.toggle('safe', !card.isBuyer);
      button.querySelector('.back .card-mark').textContent = card.emoji;
      button.querySelector('.back .card-label').textContent = card.isBuyer ? '커피 사기' : '커피 얻어먹기';
      button.querySelector('.card-by').textContent = card.by || '';
      button.classList.add('flipped');
    }
  });

  const myTurn = s.phase === 'playing' && s.turn === myId;
  board.classList.toggle('my-turn', myTurn);
  board.classList.toggle('locked', !myTurn);

  renderPlayers();
  renderStatus();

  if (firstState) {
    lastSeenEvent = s.eventSeq;
    if (s.phase === 'done') showResultModal();
  } else if (s.eventSeq > lastSeenEvent) {
    lastSeenEvent = s.eventSeq;
    if (s.event) handleEvent(s.event);
  }
}

function renderPlayers() {
  playersEl.innerHTML = state.players.map(p => {
    const classes = ['player-chip'];
    if (p.id === myId) classes.push('me');
    if (state.turn === p.id) classes.push('turn');
    if (state.buyers.includes(p.id)) classes.push('buyer');
    if (!p.online) classes.push('offline');
    const icon = state.buyers.includes(p.id) ? '☕' : (state.turn === p.id ? '👉' : (p.host ? '👑' : '🙂'));
    const tags = [p.id === myId ? '나' : '', p.host ? '방장' : ''].filter(Boolean).join('·');
    return `<span class="${classes.join(' ')}">${icon} ${escapeHtml(p.name)}${tags ? ` <small>${tags}</small>` : ''}</span>`;
  }).join('');
}

function renderStatus() {
  const onlineCount = state.players.filter(p => p.online).length;
  foundCountEl.textContent = String(state.buyers.length);
  targetCountEl.textContent = String(state.phase === 'lobby' ? (isHost ? (Number.parseInt(buyerCountInput.value, 10) || 1) : state.target) : state.target);

  if (isHost) {
    startBtn.textContent = state.phase === 'lobby' ? '카드 섞기' : '새로 섞기';
    skipBtn.classList.toggle('hidden', state.phase !== 'playing');
    buyerCountInput.max = String(Math.max(onlineCount, 1));
  }

  if (state.phase === 'lobby') {
    statusTitle.textContent = `참가자 ${onlineCount}명 대기 중`;
    statusText.textContent = isHost
      ? '초대 링크(또는 방 코드)를 공유하고, 모두 들어오면 카드 섞기를 누르세요.'
      : '방장이 카드를 섞을 때까지 기다려주세요.';
  } else if (state.phase === 'shuffling') {
    statusTitle.textContent = '카드 섞는 중...';
    statusText.textContent = '커피 사기 카드가 랜덤으로 배치되고 있습니다.';
  } else if (state.phase === 'playing') {
    const left = state.target - state.buyers.length;
    if (state.turn === myId) {
      statusTitle.textContent = '👉 내 차례예요!';
      statusText.textContent = `카드를 하나 골라 뒤집으세요. (커피 사기 ${left}명 남음)`;
    } else {
      statusTitle.textContent = `${playerName(state.turn)}님 차례`;
      statusText.textContent = `커피 사기 ${state.buyers.length}/${state.target}명 발견. 두근두근...`;
    }
  } else {
    const names = state.buyers.map(playerName);
    statusTitle.textContent = names.length ? '당첨입니다~~' : '게임 종료';
    statusText.textContent = names.length
      ? `${names.join(', ')}님이 커피 삽니다 ☕`
      : '참가자가 모두 나가서 게임이 끝났어요.';
  }
}

function handleEvent(e) {
  if (e.kind === 'join') showToast(`${e.name}님이 들어왔어요`);
  if (e.kind === 'leave') showToast(`${e.name}님이 나갔어요`);
  if (e.kind === 'reset') showToast('방장이 초기화했어요');
  if (e.kind === 'skip') showToast(`${e.name}님 차례를 넘겼어요`);
  if (e.kind === 'start') showToast(`순서: ${e.order.join(' → ')}`);

  if (e.kind === 'flip') {
    const button = board.children[e.index];
    if (e.isBuyer) {
      if (button) button.classList.add('hit');
      burstConfetti(130);
      if (!e.done) {
        const left = state.target - state.buyers.length;
        showToast(`☕ ${e.name}님 커피 사기 당첨! 아직 ${left}명 남음`);
      }
    } else {
      showToast(`😋 ${e.name}님 커피 얻어먹기`);
    }
    if (e.done) setTimeout(showResultModal, 600);
  }

  if (e.kind === 'leave' && state.phase === 'done' && state.buyers.length < state.target) showResultModal();
}

function showResultModal() {
  const names = state.buyers.map(playerName);
  const iWon = state.buyers.includes(myId);
  showModal({
    emoji: names.length ? '🎉☕🎊' : '😶',
    title: names.length ? (iWon ? '당첨입니다~~ (나!)' : '당첨입니다~~') : '게임 종료',
    text: names.length ? `${names.join(', ')}님이 커피 삽니다. 오늘 커피 잘 마시겠습니다 ☕` : '참가자가 모두 나가서 게임이 끝났어요.',
    button: isHost ? '한 번 더 하기' : '닫기',
    action: isHost ? hostStart : hideModal
  });
  if (names.length) burstConfetti(280);
}

function showModal({ emoji, title, text, button, action }) {
  modalEmoji.textContent = emoji;
  modalTitle.textContent = title;
  modalText.textContent = text;
  closeModalBtn.textContent = button;
  modalAction = action;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function hideModal() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function inviteLink() {
  return `${location.origin}${location.pathname}?room=${state.code}`;
}

async function copyInvite() {
  const link = inviteLink();
  if (location.protocol === 'file:') {
    showToast(`파일로 열면 링크가 동작하지 않아요. 방 코드 ${state.code}를 공유하세요.`);
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast('초대 링크를 복사했어요!');
  } catch (e) {
    window.prompt('아래 링크를 복사해서 공유하세요', link);
  }
}

function leaveRoom() {
  if (isHost && conns.size > 0 && !confirm('방장이 나가면 방이 종료됩니다. 나갈까요?')) return;
  if (peer) peer.destroy();
  location.href = location.pathname;
}

/* ---------- 폭죽 (원본 그대로) ---------- */
function resizeCanvas() {
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function burstConfetti(count = 160) {
  resizeCanvas();
  const originX = window.innerWidth / 2;
  const originY = window.innerHeight * 0.32;
  const colors = ['#ffcc66', '#ff5c5c', '#38d996', '#fff3df', '#8bd3ff', '#d28cff'];

  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 9;
    confettiParticles.push({
      x: originX + (Math.random() - 0.5) * 90,
      y: originY + (Math.random() - 0.5) * 40,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 5,
      gravity: 0.18 + Math.random() * 0.12,
      rotation: Math.random() * Math.PI,
      rotationSpeed: (Math.random() - 0.5) * 0.34,
      size: 6 + Math.random() * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 120 + Math.random() * 60
    });
  }

  if (!confettiAnimation) animateConfetti();
}

function animateConfetti() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  confettiParticles = confettiParticles.filter(particle => particle.life > 0);
  confettiParticles.forEach(particle => {
    particle.x += particle.vx;
    particle.y += particle.vy;
    particle.vy += particle.gravity;
    particle.rotation += particle.rotationSpeed;
    particle.life -= 1;

    ctx.save();
    ctx.translate(particle.x, particle.y);
    ctx.rotate(particle.rotation);
    ctx.globalAlpha = Math.max(particle.life / 120, 0);
    ctx.fillStyle = particle.color;
    ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.56);
    ctx.restore();
  });

  if (confettiParticles.length > 0) {
    confettiAnimation = requestAnimationFrame(animateConfetti);
  } else {
    stopConfetti();
  }
}

function stopConfetti() {
  if (confettiAnimation) cancelAnimationFrame(confettiAnimation);
  confettiAnimation = null;
  confettiParticles = [];
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

/* ---------- 이벤트 연결 ---------- */
createBtn.addEventListener('click', () => createRoom());
joinBtn.addEventListener('click', joinRoom);
roomCodeInput.addEventListener('input', () => { roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
nameInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (roomCodeInput.value.trim()) joinRoom(); else createRoom();
});
copyLinkBtn.addEventListener('click', copyInvite);
leaveBtn.addEventListener('click', leaveRoom);
startBtn.addEventListener('click', () => { hideModal(); hostStart(); });
skipBtn.addEventListener('click', hostSkip);
resetBtn.addEventListener('click', hostReset);
buyerCountInput.addEventListener('input', () => { if (state) renderStatus(); });
closeModalBtn.addEventListener('click', () => { const action = modalAction; hideModal(); if (action) action(); });
window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', e => {
  if (isHost && conns.size > 0) { e.preventDefault(); e.returnValue = ''; }
});

// 초대 링크로 들어온 경우 방 코드 자동 입력
(function init() {
  nameInput.value = loadName();
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    roomCodeInput.value = room.toUpperCase().slice(0, 4);
    createBtn.classList.add('hidden');
    document.querySelector('.divider').textContent = `초대받은 방: ${roomCodeInput.value}`;
    joinBtn.classList.remove('ghost-btn');
    joinBtn.classList.add('primary-btn');
  }
  (nameInput.value ? (room ? joinBtn : createBtn) : nameInput).focus();
  makeCards();
  resizeCanvas();
})();
