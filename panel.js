/**
 * Panel de empresa P2L — versión estática para GitHub Pages.
 * Misma UI que el panel de refactorii, pero autentica con companyId + companyKey
 * contra /public/portal/* en lugar de Google.
 */
(function () {
  'use strict';

  var API = 'https://www.refactorii.com/p2l-tenant/api/p2l-techguard-whatsapp-bot';
  var TOKEN_PREFIX = 'tg_portal_token_';
  var SOCKET_ORIGIN = 'https://www.refactorii.com';
  var SOCKET_PATH = '/p2l-tenant/socket.io';
  var CHAT_LIVE_MS = 3 * 60 * 1000;

  var state = {
    companyId: '',
    token: '',
    company: null,
    connection: null,
    busy: false,
    conversations: [],
    selectedWaFrom: '',
    chatSocketOk: false,
    chatStickToBottom: true,
    flashingWaFrom: ''
  };
  var chatPollTimer = null;
  var chatFlashTimer = null;
  var chatLiveTimer = null;
  var aiUsageTimer = null;
  var aiUsageFetchTimer = null;
  var chatSocket = null;

  /* ── utilidades ──────────────────────────────────────────────────────── */

  function $(sel) {
    return document.querySelector(sel);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatWhen(d) {
    try {
      return new Date(d).toLocaleString('es-CO');
    } catch (_) {
      return String(d || '');
    }
  }

  function formatTokens(n) {
    return Math.max(0, Number(n) || 0).toLocaleString('es-CO');
  }

  function formatUsd(n) {
    var v = Math.max(0, Number(n) || 0);
    if (v === 0) return '$0.00';
    return v >= 0.01 ? '$' + v.toFixed(2) : '$' + v.toFixed(6);
  }

  function formatWhenShort(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      var now = new Date();
      if (dt.toDateString() === now.toDateString()) {
        return dt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      }
      return dt.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
    } catch (_) {
      return String(d);
    }
  }

  function stopChatLive() {
    if (chatPollTimer) {
      clearInterval(chatPollTimer);
      chatPollTimer = null;
    }
    if (chatLiveTimer) {
      clearInterval(chatLiveTimer);
      chatLiveTimer = null;
    }
    if (aiUsageTimer) {
      clearInterval(aiUsageTimer);
      aiUsageTimer = null;
    }
    if (aiUsageFetchTimer) {
      clearTimeout(aiUsageFetchTimer);
      aiUsageFetchTimer = null;
    }
    if (chatFlashTimer) {
      clearTimeout(chatFlashTimer);
      chatFlashTimer = null;
    }
    if (chatSocket) {
      try {
        chatSocket.disconnect();
      } catch (_) {}
      chatSocket = null;
    }
    state.chatSocketOk = false;
    state.flashingWaFrom = '';
  }

  function isThreadLive(t) {
    if (!t || !t.lastMessageAt) return false;
    var at = new Date(t.lastMessageAt).getTime();
    if (!isFinite(at)) return false;
    return Date.now() - at < CHAT_LIVE_MS;
  }

  function updateLiveClassesOnly() {
    var list = $('#tg-chat-list');
    if (!list) return;
    list.querySelectorAll('[data-wa]').forEach(function (btn) {
      var wa = btn.getAttribute('data-wa') || '';
      var t = state.conversations.find(function (row) {
        return row.waFrom === wa;
      });
      var live = isThreadLive(t);
      btn.classList.toggle('tg-chats__item--live', live);
      btn.classList.toggle('tg-chats__item--live-hit', live && wa === state.flashingWaFrom);
      btn.classList.toggle('tg-chats__item--flash', wa === state.flashingWaFrom);
    });
  }

  function flashThread(waFrom) {
    state.flashingWaFrom = String(waFrom || '');
    updateLiveClassesOnly();
    if (chatFlashTimer) clearTimeout(chatFlashTimer);
    chatFlashTimer = setTimeout(function () {
      state.flashingWaFrom = '';
      updateLiveClassesOnly();
    }, 1600);
  }

  function setLiveBadge() {
    var elLive = $('#tg-chat-live');
    if (!elLive) return;
    elLive.textContent = state.chatSocketOk ? '● En vivo (socket)' : '○ Polling';
    elLive.className = 'tg-chats__live' + (state.chatSocketOk ? ' tg-chats__live--on' : '');
  }

  function isChatNearBottom() {
    var box = $('#tg-chat-msgs');
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 56;
  }

  function scrollChatToEnd() {
    var box = $('#tg-chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bindChatScroll() {
    var box = $('#tg-chat-msgs');
    if (!box || box.getAttribute('data-tg-scroll') === '1') return;
    box.setAttribute('data-tg-scroll', '1');
    box.addEventListener('scroll', function () {
      state.chatStickToBottom = isChatNearBottom();
    });
  }

  function renderChatPane(opts) {
    opts = opts || {};
    var forceBottom = opts.forceBottom === true;
    var stick = forceBottom || state.chatStickToBottom !== false;
    var prevBox = $('#tg-chat-msgs');
    var prevTop = prevBox ? prevBox.scrollTop : 0;
    var list = $('#tg-chat-list');
    var thread = $('#tg-chat-thread');
    var count = $('#tg-chat-count');
    if (!list || !thread) return;
    if (count) {
      count.textContent =
        state.conversations.length +
        ' hilo' +
        (state.conversations.length === 1 ? '' : 's');
    }
    setLiveBadge();

    if (!state.conversations.length) {
      list.innerHTML = '<p class="tg-chats__empty">Esperando mensajes de usuarios…</p>';
      thread.innerHTML =
        '<p class="tg-chats__empty">Elige un hilo o espera el primer mensaje.</p>';
      return;
    }

    var selected = state.selectedWaFrom;
    if (!selected || !state.conversations.some(function (t) { return t.waFrom === selected; })) {
      selected = state.conversations[0].waFrom;
      state.selectedWaFrom = selected;
      stick = true;
    }

    list.innerHTML = state.conversations
      .map(function (t) {
        var active = t.waFrom === selected ? ' tg-chats__item--active' : '';
        var live = isThreadLive(t) ? ' tg-chats__item--live' : '';
        var hit =
          t.waFrom === state.flashingWaFrom
            ? ' tg-chats__item--flash tg-chats__item--live-hit'
            : '';
        return (
          '<button type="button" class="tg-chats__item' +
          active +
          live +
          hit +
          '" data-wa="' +
          esc(t.waFrom) +
          '">' +
          '<span class="tg-chats__phone">' +
          esc(t.label || ('+' + t.waFrom)) +
          '</span>' +
          '<span class="tg-chats__time">' +
          esc(formatWhenShort(t.lastMessageAt)) +
          '</span>' +
          '<span class="tg-chats__preview">' +
          esc(t.preview || '—') +
          '</span></button>'
        );
      })
      .join('');

    list.querySelectorAll('[data-wa]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selectedWaFrom = btn.getAttribute('data-wa') || '';
        state.chatStickToBottom = true;
        renderChatPane({ forceBottom: true });
      });
    });

    var active = state.conversations.find(function (t) {
      return t.waFrom === selected;
    });
    if (!active) {
      thread.innerHTML = '<p class="tg-chats__empty">Sin hilo seleccionado.</p>';
      return;
    }
    var msgs = (active.messages || [])
      .map(function (m) {
        var cls =
          m.role === 'user' ? 'tg-chats__bubble--user' : 'tg-chats__bubble--bot';
        return (
          '<div class="tg-chats__bubble ' +
          cls +
          '">' +
          '<span class="tg-chats__bubble-role">' +
          (m.role === 'user' ? 'Usuario' : 'Bot') +
          '</span>' +
          '<p>' +
          esc(m.content) +
          '</p>' +
          (m.at ? '<time>' + esc(formatWhen(m.at)) + '</time>' : '') +
          '</div>'
        );
      })
      .join('');
    thread.innerHTML =
      '<header class="tg-chats__thread-head"><strong>' +
      esc(active.label || ('+' + active.waFrom)) +
      '</strong><span class="tg-muted">' +
      esc(String(active.messageCount || 0)) +
      ' msgs</span></header>' +
      '<div class="tg-chats__msgs" id="tg-chat-msgs">' +
      (msgs || '<p class="tg-chats__empty">Sin mensajes aún.</p>') +
      '</div>';
    bindChatScroll();
    var box = $('#tg-chat-msgs');
    if (!box) return;
    if (stick) {
      box.scrollTop = box.scrollHeight;
      state.chatStickToBottom = true;
    } else {
      box.scrollTop = prevTop;
    }
  }

  function conversationsSig(rows) {
    return (rows || [])
      .map(function (t) {
        return t.waFrom + ':' + (t.lastMessageAt || '') + ':' + (t.messageCount || 0);
      })
      .join('|');
  }

  function applyConversations(rows, flashFirst) {
    var prev = conversationsSig(state.conversations);
    var next = conversationsSig(rows);
    if (prev === next) {
      setLiveBadge();
      updateLiveClassesOnly();
      var count = $('#tg-chat-count');
      if (count) {
        count.textContent =
          state.conversations.length +
          ' hilo' +
          (state.conversations.length === 1 ? '' : 's');
      }
      return;
    }
    var prevByFrom = {};
    state.conversations.forEach(function (t) {
      prevByFrom[t.waFrom] = t.lastMessageAt || '';
    });
    var changedFrom = [];
    (rows || []).forEach(function (row) {
      var prevAt = prevByFrom[row.waFrom];
      if (prevAt === undefined || prevAt !== (row.lastMessageAt || '')) {
        changedFrom.push(row.waFrom);
      }
    });
    state.chatStickToBottom = isChatNearBottom();
    state.conversations = rows || [];
    renderChatPane({ forceBottom: state.chatStickToBottom });
    if (flashFirst && changedFrom[0]) flashThread(changedFrom[0]);
    else if (flashFirst && state.conversations[0]) flashThread(state.conversations[0].waFrom);
    scheduleAiUsageRefresh();
  }

  function listButtonFor(waFrom) {
    return document.querySelector('#tg-chat-list [data-wa="' + waFrom + '"]');
  }

  function upsertConversation(thread) {
    if (!thread || !thread.waFrom) return;
    var stick = isChatNearBottom();
    var idx = state.conversations.findIndex(function (t) {
      return t.waFrom === thread.waFrom;
    });
    var prev = idx >= 0 ? state.conversations[idx] : null;
    var changed =
      !prev ||
      prev.lastMessageAt !== thread.lastMessageAt ||
      prev.messageCount !== thread.messageCount;
    if (idx >= 0) state.conversations[idx] = thread;
    else state.conversations.unshift(thread);
    state.conversations.sort(function (a, b) {
      return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
    });
    if (!state.selectedWaFrom) state.selectedWaFrom = thread.waFrom;
    state.chatStickToBottom = stick;
    renderChatPane({ forceBottom: stick });
    if (changed) flashThread(thread.waFrom);
  }

  function pollConversations() {
    if (!state.token) return;
    api('/public/portal/conversations?limit=40')
      .then(function (out) {
        applyConversations(out.conversations || [], true);
      })
      .catch(function () {});
  }

  function loadSocketIo(cb) {
    if (typeof io === 'function') return cb(null);
    var s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = function () {
      cb(null);
    };
    s.onerror = function () {
      cb(new Error('socket.io cdn'));
    };
    document.head.appendChild(s);
  }

  function connectChatSocket() {
    loadSocketIo(function (err) {
      if (err || typeof io !== 'function' || !state.token) return;
      if (chatSocket) {
        try {
          chatSocket.disconnect();
        } catch (_) {}
        chatSocket = null;
      }
      chatSocket = io(SOCKET_ORIGIN, {
        path: SOCKET_PATH,
        transports: ['websocket', 'polling'],
        reconnection: true,
        auth: {
          userId: 'tg-portal-' + state.companyId,
          profile: 'techguard-wa-portal'
        }
      });
      chatSocket.on('connect', function () {
        chatSocket.emit(
          'techguard-wa-chat:subscribe',
          { portalToken: state.token },
          function (ack) {
            state.chatSocketOk = !!(ack && ack.ok);
            setLiveBadge();
            flushP2lSupport();
          }
        );
      });
      chatSocket.on('techguard-wa-chat:thread', function (payload) {
        if (payload && payload.thread) upsertConversation(payload.thread);
        scheduleAiUsageRefresh();
      });
      chatSocket.on('disconnect', function () {
        state.chatSocketOk = false;
        setLiveBadge();
      });
      chatSocket.on('connect_error', function () {
        state.chatSocketOk = false;
        setLiveBadge();
      });
      chatSocket.off('chatMessage', onP2lSupportMessage);
      chatSocket.on('chatMessage', onP2lSupportMessage);
    });
  }

  function aiUsageSignature(u) {
    if (!u) return '';
    var last = u.lastCall || {};
    var month = u.month || {};
    return [
      u.requests,
      u.promptTokens,
      u.completionTokens,
      u.totalTokens,
      u.fallbacks,
      u.errors,
      last.at || '',
      last.source || '',
      month.requests,
      month.totalTokens,
      u.groqEnabled ? 1 : 0
    ].join('|');
  }

  /** El consumo vive en la empresa y la sesión solo se carga al entrar. */
  function patchAiUsage(u) {
    if (!u || !state.company) return;
    if (aiUsageSignature(state.company.aiUsage) === aiUsageSignature(u)) return;
    state.company.aiUsage = u;
    var host = document.querySelector('.tg-board__ai');
    if (!host) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = aiUsageHtml(u);
    if (wrap.firstElementChild) host.replaceWith(wrap.firstElementChild);
  }

  function pollAiUsage() {
    if (!state.token || !state.company) return;
    api('/public/portal/session')
      .then(function (out) {
        if (out && out.company && out.company.aiUsage) patchAiUsage(out.company.aiUsage);
        if (out && out.company) patchGeoUsage(out.company);
      })
      .catch(function () {});
  }

  function scheduleAiUsageRefresh() {
    if (aiUsageFetchTimer) clearTimeout(aiUsageFetchTimer);
    aiUsageFetchTimer = setTimeout(pollAiUsage, 1200);
  }

  function startChatLive() {
    stopChatLive();
    pollConversations();
    pollAiUsage();
    connectChatSocket();
    chatPollTimer = setInterval(pollConversations, 3000);
    chatLiveTimer = setInterval(updateLiveClassesOnly, 8000);
    aiUsageTimer = setInterval(pollAiUsage, 8000);
  }

  function chatsSectionHtml() {
    return (
      '<section class="tg-panel tg-board__chats tg-chats">' +
      '<div class="tg-panel__head"><div><h2>Conversaciones en vivo</h2>' +
      '<p class="tg-ctx__lead">Mensajes reales del webhook ↔ bot (memoria corta en BD).</p></div>' +
      '<div class="tg-chats__status">' +
      '<span class="tg-chats__live" id="tg-chat-live">○ Polling</span>' +
      '<span class="tg-muted" id="tg-chat-count">0 hilos</span></div></div>' +
      '<div class="tg-chats__body">' +
      '<aside class="tg-chats__list" id="tg-chat-list" aria-label="Hilos de WhatsApp"></aside>' +
      '<div class="tg-chats__thread" id="tg-chat-thread"></div>' +
      '</div></section>'
    );
  }

  /** El id viaja en la ruta (/company/<id>), en ?c= o en el hash. */
  function readCompanyId() {
    var injected = window.TG_COMPANY_ID || '';
    if (/^[a-f\d]{24}$/i.test(injected)) return String(injected).toLowerCase();
    var m = location.pathname.match(/\/company\/([a-f\d]{24})/i);
    if (m) return m[1].toLowerCase();
    var q = new URLSearchParams(location.search).get('c') || '';
    if (/^[a-f\d]{24}$/i.test(q)) return q.toLowerCase();
    var h = (location.hash || '').replace(/^#\/?(company\/)?/, '');
    return /^[a-f\d]{24}$/i.test(h) ? h.toLowerCase() : '';
  }

  function tokenKey() {
    return TOKEN_PREFIX + state.companyId;
  }

  function loadToken() {
    try {
      return localStorage.getItem(tokenKey()) || '';
    } catch (_) {
      return '';
    }
  }

  function saveToken(t) {
    try {
      if (t) localStorage.setItem(tokenKey(), t);
      else localStorage.removeItem(tokenKey());
    } catch (_) {}
  }

  /* ── API ─────────────────────────────────────────────────────────────── */

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try {
          data = txt ? JSON.parse(txt) : null;
        } catch (_) {
          data = { message: txt };
        }
        if (!res.ok) {
          var err = new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ── pantalla de acceso ──────────────────────────────────────────────── */

  function renderGate(msg) {
    mountP2lSupportChat(false);
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<div class="tg-gate"><div class="tg-gate__card">' +
      '<p class="tg-gate__brand">P2L</p>' +
      '<p class="tg-gate__eyebrow">Panel de empresa · Bot WhatsApp IA</p>' +
      '<p class="tg-gate__lead">Escribe la clave de empresa que te entregó el cluster. ' +
      'Solo la primera vez: después este enlace abrirá tu panel directamente.</p>' +
      (state.companyId ? '<code class="tg-gate__id">' + esc(state.companyId) + '</code>' : '') +
      (msg ? '<p class="tg-err">' + esc(msg) + '</p>' : '') +
      '<label class="tg-field"><span>Clave de empresa</span>' +
      '<input id="tg-key" type="password" autocomplete="current-password" placeholder="Clave de empresa" /></label>' +
      '<button type="button" class="tg-btn" id="tg-enter">Entrar a mi panel</button>' +
      '<p class="tg-gate__foot">¿Perdiste la clave? Escríbenos y te la regeneramos.</p>' +
      '</div></div>';

    var input = $('#tg-key');
    var btn = $('#tg-enter');
    input.focus();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') btn.click();
    });
    btn.addEventListener('click', function () {
      var key = input.value.trim();
      if (!key) return renderGate('Escribe tu clave de empresa.');
      btn.disabled = true;
      btn.textContent = 'Entrando…';
      api('/public/portal/login', {
        method: 'POST',
        body: { companyId: state.companyId, companyKey: key }
      })
        .then(function (out) {
          state.token = out.token;
          saveToken(out.token);
          state.company = out.company;
          state.connection = out.connection;
          renderPanel();
        })
        .catch(function (e) {
          renderGate(e.message || 'No pudimos validar la clave.');
        });
    });
  }

  /* ── panel ───────────────────────────────────────────────────────────── */

  function geoUsageHtml(c) {
    var g = c.components && c.components.geoapify;
    var u = c.geoUsage;
    if (!g || !g.enabled || !u) return '';
    var last = u.lastCall && u.lastCall.at ? formatWhen(u.lastCall.at) : '';
    return (
      '<section class="tg-panel tg-board__geo">' +
      '<div class="tg-panel__head"><h2>Consumo Geoapify</h2><span class="tg-chip">esta empresa</span></div>' +
      '<p class="tg-muted tg-ai__line">' + (u.requests || 0) + ' consultas hoy · ' +
      (u.monthRequests || 0) + ' en el mes' +
      (u.errors ? ' · ' + u.errors + ' con error' : '') +
      (last ? ' · última ' + esc(last) : '') +
      '</p></section>'
    );
  }

  function patchGeoUsage(company) {
    if (!company || !state.company) return;
    state.company.geoUsage = company.geoUsage;
    state.company.components = company.components || state.company.components;
    var host = document.querySelector('.tg-board__geo');
    var html = geoUsageHtml(state.company);
    if (!html) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      var ai = document.querySelector('.tg-board__ai');
      if (!ai) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      if (wrap.firstElementChild) ai.insertAdjacentElement('afterend', wrap.firstElementChild);
      return;
    }
    var wrap2 = document.createElement('div');
    wrap2.innerHTML = html;
    if (wrap2.firstElementChild) host.replaceWith(wrap2.firstElementChild);
  }

  function aiUsageHtml(u) {
    if (!u) return '';
    if (!u.groqEnabled) {
      return (
        '<section class="tg-panel tg-board__ai">' +
        '<div class="tg-panel__head"><h2>Consumo de IA</h2>' +
        '<span class="tg-chip">' + esc(u.model) + '</span></div>' +
        '<p class="tg-muted">Sin clave de Groq configurada: el bot responde con el mensaje base, sin IA. ' +
        'Pídele al cluster que active tu cuenta de Groq.</p></section>'
      );
    }
    var fill =
      u.quotaExhausted || u.percentUsed >= 95
        ? ' tg-ai__fill--danger'
        : u.percentUsed >= 75
          ? ' tg-ai__fill--warn'
          : '';
    var extra = '';
    if (u.fallbacks || u.errors) {
      extra +=
        '<p class="tg-muted tg-ai__line">' + u.fallbacks + ' respuestas sin IA hoy' +
        (u.errors ? ' · ' + u.errors + ' con error' : '') + '</p>';
    }
    if (u.lastCall) {
      extra +=
        '<p class="tg-muted tg-ai__line">Última: ' + esc(formatWhen(u.lastCall.at)) + ' · ' +
        (u.lastCall.source === 'groq' ? 'generada con IA' : 'mensaje base') +
        (u.lastCall.error ? ' · ' + esc(u.lastCall.error) : '') + '</p>';
    }
    return (
      '<section class="tg-panel tg-board__ai">' +
      '<div class="tg-panel__head"><h2>Consumo de IA</h2>' +
      '<span class="tg-chip">' + esc(u.model) + '</span></div>' +
      '<div class="tg-ai__row"><span class="tg-ai__big">' + u.requests +
      '<small> / ' + u.limit + ' respuestas con IA hoy</small></span>' +
      '<span class="tg-ai__cost">' + formatUsd(u.costUsd.total) + '</span></div>' +
      '<div class="tg-ai__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      u.percentUsed + '"><div class="tg-ai__fill' + fill + '" style="width:' + u.percentUsed + '%"></div></div>' +
      '<p class="tg-muted tg-ai__line">' + formatTokens(u.promptTokens) + ' tok entrada · ' +
      formatTokens(u.completionTokens) + ' tok salida · ' + u.tokenPercentUsed +
      '% del cupo diario de tokens' +
      (u.quotaExhausted ? '<strong class="tg-ai__warn"> · cupo agotado</strong>' : '') + '</p>' +
      '<p class="tg-muted tg-ai__line">Mes ' + esc(u.month.key) + ': ' + u.month.requests +
      ' respuestas · ' + formatTokens(u.month.totalTokens) + ' tok · <strong>' +
      formatUsd(u.month.costUsd.total) + '</strong></p>' +
      extra +
      '</section>'
    );
  }

  function waSectionHtml(c, conn) {
    var managed = c.waManagedBy;
    if (managed !== 'customer' && managed !== 'hybrid') {
      return (
        '<section class="tg-panel tg-board__wa"><h2>WhatsApp Cloud API</h2>' +
        '<p class="tg-muted">El cluster configura Meta por ti. Webhook: <code>' +
        esc((conn && conn.webhookUrl) || '') + '</code></p></section>'
      );
    }
    var HINT_BM = 'impórtalo de tu cuenta de WhatsApp en business.facebook.com';
    var HINT_APP = 'impórtalo de developers.facebook.com › configuración de la app › configuración básica';
    var HINT_TOKEN = 'impórtalo desde business.facebook.com → Usuarios del sistema → Generar token → token permanente';
    var f = function (id, label, hint, ph, val, type) {
      return (
        '<label class="tg-field"><span>' + esc(label) +
        (hint ? ' <em class="tg-hint">' + esc(hint) + '</em>' : '') + '</span>' +
        '<input id="' + id + '" type="' + (type || 'text') + '" placeholder="' + esc(ph) +
        '" value="' + esc(val || '') + '" /></label>'
      );
    };
    conn = conn || {};
    // Campo azul de solo lectura: el backend lo emite, el cliente solo lo copia a Meta.
    var ro = function (id, label, hint, val, btnId, btnTitle) {
      return (
        '<label class="tg-field tg-span-full"><span>' + esc(label) +
        ' <em class="tg-hint">' + esc(hint) + '</em></span>' +
        '<span class="tg-ro-wrap">' +
        '<input id="' + id + '" class="tg-input--ro" readonly tabindex="-1" value="' + esc(val || '') + '" />' +
        '<button type="button" class="tg-copy" id="' + btnId + '" title="' + esc(btnTitle) + '">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="9" width="12" height="12" rx="2"></rect>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
        '</svg></button></span></label>'
      );
    };
    return (
      '<section class="tg-panel tg-board__wa">' +
      '<div class="tg-panel__head"><h2>Conexión WhatsApp</h2>' +
      '<button type="button" class="tg-btn sm" id="tg-save-wa">Guardar WA</button></div>' +
      '<p class="tg-muted">Salud: <strong>' + esc(conn.health || 'unknown') + '</strong> · Último webhook: ' +
      (conn.lastWebhookAt ? esc(formatWhen(conn.lastWebhookAt)) : 'aún no llega ninguno') + '</p>' +
      '<div class="tg-grid tg-grid--wa">' +
      f('tg-wa-app', 'Meta App ID', HINT_BM, 'App ID', conn.metaAppId) +
      f('tg-wa-waba', 'WABA ID', HINT_BM, 'WABA ID', conn.wabaId) +
      f('tg-wa-phone', 'Phone Number ID', HINT_BM, 'Phone Number ID', conn.phoneNumberId) +
      f('tg-wa-display', 'Número visible', '', '+57…', conn.displayPhone) +
      ro(
        'tg-wa-webhook',
        'Webhook',
        'este es el webhook del bot en la app de Meta, en developers.facebook.com — ' +
          'Paso 2: Configuración de producción › URL de devolución de llamada',
        conn.webhookUrl,
        'tg-copy-webhook',
        'Copiar webhook'
      ) +
      ro(
        'tg-wa-verify',
        'Verify token',
        'expórtalo al campo «Token de verificación» del Paso 2: Configuración de producción, ' +
          'en developers.facebook.com — lo genera el cluster, es de solo lectura',
        conn.verifyToken,
        'tg-copy-verify',
        'Copiar verify token'
      ) +
      f('tg-wa-secret', 'App Secret', HINT_APP, conn.hasAppSecret ? '•••• guardado' : 'App Secret', '', 'password') +
      f('tg-wa-token', 'Access Token', HINT_TOKEN, conn.hasAccessToken ? '•••• guardado' : 'Access Token', '', 'password') +
      '</div></section>'
    );
  }

  function skillLearnHtml() {
    return (
      '<p class="tg-learn">Aprender más ' +
      '<a href="https://agentskills.io/" target="_blank" rel="noopener noreferrer">agentskills.io</a>' +
      '<a href="https://skills.md/" target="_blank" rel="noopener noreferrer">skills.md</a></p>'
    );
  }

  function wabaReady(c, conn) {
    var caps = c && c.planSpec && c.planSpec.agentCapabilities;
    var contracted = !caps || typeof caps.whatsapp !== 'boolean' || caps.whatsapp === true;
    var digits = String((conn && conn.displayPhone) || '').replace(/\D/g, '');
    return contracted && !!(conn && conn.phoneNumberId && conn.hasAccessToken && digits.length >= 8);
  }

  function waFloatSnippet(link, phoneLabel, companyId, ready) {
    var off = ready ? '' : ' is-off';
    var href = ready ? link : '#';
    var attrs = ready
      ? ' target="_blank" rel="noopener noreferrer"'
      : ' aria-disabled="true" title="Contrata o configura WhatsApp (WABA Meta) para activar este botón"';
    return '<style>\n' +
      '.wa-float {\n' +
      '  position: fixed;\n' +
      '  right: 18px;\n' +
      '  bottom: 18px;\n' +
      '  z-index: 40;\n' +
      '  width: 56px;\n' +
      '  height: 56px;\n' +
      '  display: block;\n' +
      '  line-height: 0;\n' +
      '  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28));\n' +
      '}\n' +
      '.wa-float svg { width: 56px; height: 56px; display: block; }\n' +
      '.wa-float:hover { filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28)) brightness(1.06); }\n' +
      '.wa-float.is-off { filter: grayscale(1); opacity: 0.55; cursor: not-allowed; }\n' +
      '.wa-float.is-off:hover { filter: grayscale(1); }\n' +
      '</style>\n' +
      '<a id="p2l-wa-float" class="wa-float' + off + '" href="' + href + '"' + attrs + ' data-company-id="' + esc(companyId || '') + '" aria-label="WhatsApp ' + phoneLabel + '">\n' +
      '  <svg viewBox="-2.73 0 1225.016 1225.016" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">\n' +
      '    <path fill="#E0E0E0" d="M1041.858 178.02C927.206 63.289 774.753.07 612.325 0 277.617 0 5.232 272.298 5.098 606.991c-.039 106.986 27.915 211.42 81.048 303.476L0 1225.016l321.898-84.406c88.689 48.368 188.547 73.855 290.166 73.896h.258.003c334.654 0 607.08-272.346 607.222-607.023.056-162.208-63.052-314.724-177.689-429.463zm-429.533 933.963h-.197c-90.578-.048-179.402-24.366-256.878-70.339l-18.438-10.93-191.021 50.083 51-186.176-12.013-19.087c-50.525-80.336-77.198-173.175-77.16-268.504.111-278.186 226.507-504.503 504.898-504.503 134.812.056 261.519 52.604 356.814 147.965 95.289 95.36 147.728 222.128 147.688 356.948-.118 278.195-226.522 504.543-504.693 504.543z"/>\n' +
      '    <linearGradient id="waFloatGreen" gradientUnits="userSpaceOnUse" x1="609.77" y1="1190.114" x2="609.77" y2="21.084">\n' +
      '      <stop offset="0" stop-color="#20b038"/>\n' +
      '      <stop offset="1" stop-color="#60d66a"/>\n' +
      '    </linearGradient>\n' +
      '    <path fill="url(#waFloatGreen)" d="M27.875 1190.114l82.211-300.18c-50.719-87.852-77.391-187.523-77.359-289.602.133-319.398 260.078-579.25 579.469-579.25 155.016.07 300.508 60.398 409.898 169.891 109.414 109.492 169.633 255.031 169.57 409.812-.133 319.406-260.094 579.281-579.445 579.281-.023 0 .016 0 0 0h-.258c-96.977-.031-192.266-24.375-276.898-70.5l-307.188 80.548z"/>\n' +
      '    <path fill="#fff" fill-rule="evenodd" d="M462.273 349.294c-11.234-24.977-23.062-25.477-33.75-25.914-8.742-.375-18.75-.352-28.742-.352-10 0-26.25 3.758-39.992 18.766-13.75 15.008-52.5 51.289-52.5 125.078 0 73.797 53.75 145.102 61.242 155.117 7.5 10 103.758 166.266 256.203 226.383 126.695 49.961 152.477 40.023 179.977 37.523s88.734-36.273 101.234-71.297c12.5-35.016 12.5-65.031 8.75-71.305-3.75-6.25-13.75-10-28.75-17.5s-88.734-43.789-102.484-48.789-23.75-7.5-33.75 7.516c-10 15-38.727 48.773-47.477 58.773-8.75 10.023-17.5 11.273-32.5 3.773-15-7.523-63.305-23.344-120.609-74.438-44.586-39.75-74.688-88.844-83.438-103.859-8.75-15-.938-23.125 6.586-30.602 6.734-6.719 15-17.508 22.5-26.266 7.484-8.758 9.984-15.008 14.984-25.008 5-10.016 2.5-18.773-1.25-26.273s-32.898-81.67-46.234-111.326z"/>\n' +
      '    <path fill="#fff" d="M1036.898 176.091C923.562 62.677 772.859.185 612.297.114 281.43.114 12.172 269.286 12.039 600.137 12 705.896 39.633 809.13 92.156 900.13L7 1211.067l318.203-83.438c87.672 47.812 186.383 73.008 286.836 73.047h.255.003c330.812 0 600.109-269.219 600.25-600.055.055-160.343-62.328-311.108-175.649-424.53zm-424.601 923.242h-.195c-89.539-.047-177.344-24.086-253.93-69.531l-18.227-10.805-188.828 49.508 50.414-184.039-11.875-18.867c-49.945-79.414-76.312-171.188-76.273-265.422.109-274.992 223.906-498.711 499.102-498.711 133.266.055 258.516 52 352.719 146.266 94.195 94.266 146.031 219.578 145.992 352.852-.118 274.999-223.923 498.749-498.899 498.749z"/>\n' +
      '  </svg>\n' +
      '</a>\n' +
      '<script>\n' +
      '(function(){var el=document.getElementById("p2l-wa-float");if(!el)return;var id=el.getAttribute("data-company-id")||"";el.addEventListener("click",function(ev){if(el.classList.contains("is-off"))ev.preventDefault();});if(!id)return;fetch("https://www.refactorii.com/p2l-tenant/api/p2l-techguard-whatsapp-bot/public/company/"+encodeURIComponent(id)+"/channels").then(function(r){return r.ok?r.json():null;}).then(function(data){if(!data||!data.whatsapp||!data.waLink)return;el.classList.remove("is-off");el.setAttribute("href",data.waLink);el.setAttribute("target","_blank");el.setAttribute("rel","noopener noreferrer");el.removeAttribute("aria-disabled");el.removeAttribute("title");}).catch(function(){});})();\n' +
      '</script>';
  }

  function floatPack(c, conn) {
    var name = String((c && c.name) || '').trim() || 'tu empresa';
    var ready = wabaReady(c, conn);
    var digits = String((conn && conn.displayPhone) || '').replace(/\D/g, '');
    var text = 'Hola agente de ' + name + '! quiero mas info para mi negocio';
    var link = ready ? ('https://wa.me/' + digits + '?text=' + encodeURIComponent(text)) : '#';
    var label = digits ? ('+' + digits) : name;
    return { name: name, link: link, html: waFloatSnippet(link, label, state.companyId, ready) };
  }

  function planOn(id) {
    var caps = state.company && state.company.planSpec && state.company.planSpec.agentCapabilities;
    if (caps && typeof caps[id] === 'boolean') return caps[id] === true;
    return id !== 'devopsChat';
  }

  function markPlanOff(el) {
    if (!el || el.classList.contains('is-plan-off')) return;
    el.classList.add('is-plan-off');
    el.querySelectorAll('input, textarea, select, button').forEach(function (node) {
      node.disabled = true;
    });
    if (!el.querySelector('.tg-plan-lock')) {
      var note = document.createElement('p');
      note.className = 'tg-plan-lock';
      note.textContent = 'Tu plan no incluye esta capacidad.';
      el.insertBefore(note, el.firstChild);
    }
  }

  function applyPlanLocks() {
    if (!planOn('groq')) markPlanOff(document.querySelector('.tg-board__ai'));
    if (!planOn('geoapify')) markPlanOff(document.querySelector('.tg-board__geo'));
    if (!planOn('chat')) markPlanOff(document.querySelector('.tg-board__chats'));
    if (!planOn('skill')) {
      var skill = document.getElementById('tg-skill');
      if (skill) markPlanOff(skill.closest('.tg-ctx__block'));
    }
    if (!planOn('capabilities')) {
      var caps = document.getElementById('tg-caps');
      if (caps) markPlanOff(caps.closest('.tg-ctx__block'));
      markPlanOff(document.querySelector('.tg-ctx__block--links'));
    }
    if (!planOn('whatsapp')) {
      markPlanOff(document.querySelector('.tg-board__wa'));
      markPlanOff(document.querySelector('.tg-board__tutorial'));
      markPlanOff(document.querySelector('.tg-float-kit'));
    }
    var ctxSave = document.getElementById('tg-save-ctx');
    if (ctxSave && !planOn('skill') && !planOn('capabilities')) ctxSave.disabled = true;
  }

  function companyHeadline(c) {
    var name = (c && c.name) || 'Empresa';
    var plan = (c && c.planSpec && c.planSpec.name) || (c && c.plan) || '';
    var bits = [name, 'Bot WhatsApp IA'];
    if (plan) bits.push('Plan ' + plan);
    if (c && c.waManagedBy) bits.push('WA ' + c.waManagedBy);
    if (c && c.subscriptionStatus) bits.push(String(c.subscriptionStatus));
    return bits.map(function (bit) { return esc(bit); }).join('<span class="tg-co__sep">|</span>');
  }

  function renderPanel() {
    var c = state.company;
    document.title = (c.name || 'Empresa') + ' · Bot WhatsApp IA';
    var conn = state.connection;
    var b = c.brand || {};
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<header class="tg-co__header">' +
      '<h1 class="tg-co__headline">' + companyHeadline(c) + '</h1>' +
      '<div class="tg-co__nav"><button type="button" class="tg-btn ghost" id="tg-logout">Salir</button></div>' +
      '</header>' +
      '<p class="tg-err tg-hidden" id="tg-err"></p>' +
      '<p class="tg-note tg-hidden" id="tg-note"></p>' +
      '<div class="tg-board">' +
      '<section class="tg-panel tg-board__brand">' +
      '<div class="tg-panel__head"><h2>Marca del bot</h2>' +
      '<button type="button" class="tg-btn sm" id="tg-save-brand">Guardar marca</button></div>' +
      '<div class="tg-grid tg-grid--brand">' +
      '<label class="tg-field"><span>Nombre</span><input id="tg-b-name" value="' + esc(b.botName) + '" placeholder="Nombre del bot" /></label>' +
      '<label class="tg-field"><span>Tono</span><input id="tg-b-tone" value="' + esc(b.tone) + '" placeholder="Tono" /></label>' +
      '<label class="tg-field"><span>Idioma</span><input id="tg-b-lang" value="' + esc(b.language) + '" placeholder="es" /></label>' +
      '<label class="tg-field"><span>Horario</span><input id="tg-b-hours" value="' + esc(b.hours) + '" placeholder="Lun-Vie…" /></label>' +
      '<label class="tg-field tg-field--wide"><span>Disclaimer</span><input id="tg-b-disc" value="' + esc(b.disclaimer) + '" placeholder="Disclaimer" /></label>' +
      '</div></section>' +
      aiUsageHtml(c.aiUsage) +
      geoUsageHtml(c) +
      chatsSectionHtml() +
      '<section class="tg-panel tg-board__ctx">' +
      '<div class="tg-panel__head"><div><h2>Contexto del bot</h2>' +
      '<p class="tg-ctx__lead">Skill, capacidades y enlaces que usa el agente para responder.</p></div>' +
      '<button type="button" class="tg-btn sm" id="tg-save-ctx">Guardar contexto</button></div>' +
      '<div class="tg-ctx__row">' +
      '<div class="tg-ctx__block">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Skill negocio</h3><span class="tg-chip">markdown</span></div>' +
      skillLearnHtml() +
      '<textarea id="tg-skill" class="tg-area tg-area--fill"></textarea>' +
      '<div class="tg-float-kit">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Botón flotante</h3>' +
      '<button type="button" class="tg-btn ghost sm" id="tg-copy-float">Copiar HTML</button></div>' +
      '<p class="tg-muted">HTML y CSS del botón de WhatsApp de ' + esc(c.name || 'esta empresa') + '. Pégalo en la página.</p>' +
      '<textarea id="tg-float-html" class="tg-area tg-float-kit__code" rows="8" readonly></textarea></div></div>' +
      '<div class="tg-ctx__block">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>Capacidades de producto</h3>' +
      '<span class="tg-chip">product-capabilities.json</span></div>' +
      '<textarea id="tg-caps" class="tg-area tg-area--fill" placeholder=\'{"capabilities":[]}\'></textarea></div>' +
      '</div>' +
      '<div class="tg-ctx__block tg-ctx__block--links">' +
      '<div class="tg-panel__head tg-panel__head--sub"><h3>MCP · Link de pago</h3></div>' +
      '<div class="tg-grid tg-grid--links">' +
      '<label class="tg-field"><span>MCP URL (opcional)</span><input id="tg-mcp" placeholder="https://…/mcp" /></label>' +
      '<label class="tg-field"><span>Link de pago</span><input id="tg-pay" placeholder="https://checkout…" /></label>' +
      '</div></div></section>' +
      '<section class="tg-panel tg-board__tutorial tg-tutorial">' +
      '<h2>Tutorial Meta Cloud API</h2>' +
      '<p class="tg-muted tg-tutorial__lead">Tu empresa configura Meta; el cluster es el <strong>webhook</strong> que recibe y responde.</p>' +
      '<ol class="tg-tutorial__steps">' +
      '<li><strong>App Meta</strong>' +
      '<a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">My Apps</a> → WhatsApp · ' +
      '<a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/" target="_blank" rel="noopener">Get started</a></li>' +
      '<li><strong>Número</strong>Phone Number ID + WABA · ' +
      '<a href="https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/" target="_blank" rel="noopener">docs</a></li>' +
      '<li><strong>Token permanente</strong>' +
      '<a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener">System Users</a></li>' +
      '<li><strong>Datos abajo</strong>App ID, Secret, WABA, Phone ID, token, Verify Token</li>' +
      '<li><strong>Webhook</strong>Callback = <code>' + esc((conn && conn.webhookUrl) || '…/wa/webhook') +
      '</code> · suscribe <code>messages</code></li>' +
      '<li><strong>Tarifas Meta</strong>' +
      '<a href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noopener">precios oficiales</a></li>' +
      '</ol>' +
      '</section>' +
      waSectionHtml(c, conn) +
      /* Más adelante: Orquestador · RUNBOOK (OpenCode / Anomaly)
      '<section class="tg-panel tg-board__orch"><h2>RUNBOOK</h2>' +
      '<textarea class="tg-area tg-area--fill" id="tg-runbook" readonly></textarea></section>' +
      */
      '</div>';

    // textareas por valor, no por atributo, para no romper con < y &
    $('#tg-skill').value = (c.skills && c.skills[0] && c.skills[0].content) || '';
    var floatBox = $('#tg-float-html');
    if (floatBox) floatBox.value = floatPack(c, conn).html;
    $('#tg-caps').value = JSON.stringify(
      c.productCapabilities && typeof c.productCapabilities === 'object'
        ? c.productCapabilities
        : { capabilities: [] },
      null,
      2
    );
    $('#tg-mcp').value = (c.mcpServers && c.mcpServers[0] && c.mcpServers[0].url) || '';
    $('#tg-pay').value = (c.paymentLinks && c.paymentLinks[0] && c.paymentLinks[0].url) || '';
    // Más adelante: $('#tg-flows') / $('#tg-runbook')

    $('#tg-logout').addEventListener('click', function () {
      stopChatLive();
      saveToken('');
      state.token = '';
      state.conversations = [];
      state.selectedWaFrom = '';
      renderGate('');
    });
    $('#tg-save-brand').addEventListener('click', saveBrand);
    $('#tg-save-ctx').addEventListener('click', saveContext);
    var waBtn = $('#tg-save-wa');
    if (waBtn) waBtn.addEventListener('click', saveWa);
    bindCopy('#tg-copy-float', '#tg-float-html', 'HTML del botón flotante copiado');
    bindCopy('#tg-copy-webhook', '#tg-wa-webhook', 'Webhook copiado. Pégalo en «URL de devolución de llamada» en Meta');
    bindCopy('#tg-copy-verify', '#tg-wa-verify', 'Verify token copiado. Pégalo en el Paso 2 de developers.facebook.com');
    startChatLive();
    applyPlanLocks();
    mountP2lSupportChat();
  }

  function bindCopy(btnSel, inputSel, msg) {
    var btn = $(btnSel);
    var input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener('click', function () {
      if (!input.value || !navigator.clipboard) return;
      navigator.clipboard.writeText(input.value).then(function () {
        flash('note', msg);
      });
    });
  }

  function flash(kind, msg) {
    var n = $('#tg-' + kind);
    if (!n) return;
    n.textContent = msg;
    n.classList.remove('tg-hidden');
    if (kind === 'note') setTimeout(function () { n.classList.add('tg-hidden'); }, 4000);
  }

  function afterSave(out) {
    if (out.company) state.company = out.company;
    if (out.connection) state.connection = out.connection;
    var keepFrom = state.selectedWaFrom;
    var keepRows = state.conversations.slice();
    renderPanel();
    state.selectedWaFrom = keepFrom;
    state.conversations = keepRows;
    renderChatPane();
    flash('note', 'Guardado');
  }

  function onError(e) {
    if (e.status === 401) {
      saveToken('');
      state.token = '';
      return renderGate('Tu sesión caducó. Vuelve a entrar con tu clave.');
    }
    flash('err', e.message || 'No se pudo guardar');
  }

  function saveBrand() {
    api('/public/portal/company', {
      method: 'PATCH',
      body: {
        brand: {
          botName: $('#tg-b-name').value.trim(),
          tone: $('#tg-b-tone').value.trim(),
          language: $('#tg-b-lang').value.trim(),
          hours: $('#tg-b-hours').value.trim(),
          disclaimer: $('#tg-b-disc').value.trim()
        }
      }
    }).then(afterSave).catch(onError);
  }

  function saveContext() {
    if (!planOn('skill') && !planOn('capabilities')) return;
    var productCapabilities;
    // Más adelante: editar flujos en UI. Hoy se preservan desde state.company.
    var flows = Array.isArray(state.company && state.company.flows) ? state.company.flows : [];
    try {
      productCapabilities = JSON.parse($('#tg-caps').value || '{"capabilities":[]}');
      if (!productCapabilities || typeof productCapabilities !== 'object' || Array.isArray(productCapabilities)) {
        throw new Error('debe ser un objeto con capabilities[]');
      }
      if (!Array.isArray(productCapabilities.capabilities)) {
        throw new Error('falta capabilities[]');
      }
    } catch (e) {
      return flash('err', 'Capacidades JSON inválido: ' + e.message);
    }
    var mcp = $('#tg-mcp').value.trim();
    var pay = $('#tg-pay').value.trim();
    var body = { flows: flows };
    if (planOn('skill')) body.skills = [{ path: 'negocio.md', content: $('#tg-skill').value }];
    if (planOn('capabilities')) {
      body.productCapabilities = productCapabilities;
      body.mcpServers = mcp ? [{ name: 'mcp', type: 'sse', url: mcp }] : [];
      body.paymentLinks = pay ? [{ label: 'Pago', url: pay }] : [];
    }
    api('/public/portal/company', {
      method: 'PATCH',
      body: body
    }).then(afterSave).catch(onError);
  }

  function saveWa() {
    if (!planOn('whatsapp')) return flash('err', 'Tu plan no incluye WhatsApp.');
    var body = {
      metaAppId: $('#tg-wa-app').value.trim(),
      wabaId: $('#tg-wa-waba').value.trim(),
      phoneNumberId: $('#tg-wa-phone').value.trim(),
      displayPhone: $('#tg-wa-display').value.trim(),
      verifyToken: $('#tg-wa-verify').value.trim()
    };
    var secret = $('#tg-wa-secret').value.trim();
    var token = $('#tg-wa-token').value.trim();
    if (secret) body.appSecret = secret;
    if (token) body.accessToken = token;
    api('/public/portal/connection', { method: 'PUT', body: body })
      .then(afterSave)
      .catch(onError);
  }

  /* ── chat de soporte P2L (mismo canal chatMessage del Semantic IDE) ── */

  var P2L_SUPPORT_TO = 'jaalza@gmail.com';
  var p2lSupportRows = [];
  var p2lSupportOpen = false;
  var p2lSupportUnread = 0;

  function p2lSupportMe() {
    return 'tg-portal-' + (state.companyId || '');
  }

  function p2lSupportRoom() {
    return 'direct-' + [p2lSupportMe(), P2L_SUPPORT_TO].sort().join('_');
  }

  function devopsChatEnabled() {
    var caps = state.company && state.company.planSpec && state.company.planSpec.agentCapabilities;
    return !!(caps && caps.devopsChat === true);
  }

  function p2lSupportStoreKey() {
    return 'p2l-support-chat-' + (state.companyId || 'x');
  }

  function loadP2lSupportRows() {
    try {
      var raw = sessionStorage.getItem(p2lSupportStoreKey());
      var parsed = raw ? JSON.parse(raw) : [];
      p2lSupportRows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      p2lSupportRows = [];
    }
  }

  function saveP2lSupportRows() {
    try {
      var slim = p2lSupportRows.slice(-80).map(function (r) {
        return { id: r.id, text: r.text, mine: !!r.mine };
      });
      sessionStorage.setItem(p2lSupportStoreKey(), JSON.stringify(slim));
    } catch (e) {}
  }

  function flushP2lSupport() {
    if (!chatSocket || !chatSocket.connected) return;
    p2lSupportRows.forEach(function (row) {
      if (!row.pending || !row.payload) return;
      chatSocket.emit('chatMessage', row.payload);
      row.pending = false;
      row.payload = null;
    });
  }

  function mountP2lSupportChat(force) {
    var oldFab = document.getElementById('p2l-support-fab');
    var oldBox = document.getElementById('p2l-support-box');
    if (force === false) {
      if (oldFab) oldFab.remove();
      if (oldBox) oldBox.remove();
      p2lSupportOpen = false;
      return;
    }
    var on = devopsChatEnabled();
    if (!on && oldBox) oldBox.remove();
    if (!on) p2lSupportOpen = false;
    if (oldFab) oldFab.remove();
    if (on && !p2lSupportRows.length) loadP2lSupportRows();
    var fab = document.createElement('button');
    fab.id = 'p2l-support-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Chat de soporte P2L');
    fab.innerHTML = '<span class="p2l-support-fab__mark">P2L</span><span>Soporte</span>';
    if (!on) {
      fab.className = 'is-locked';
      fab.setAttribute('aria-disabled', 'true');
      fab.title = 'Contrata Soporte Devops P2L Chat para activar este chat';
    } else {
      fab.title = 'Chat de soporte P2L';
      fab.addEventListener('click', function () {
        p2lSupportOpen = !p2lSupportOpen;
        p2lSupportUnread = 0;
        renderP2lSupport();
      });
    }
    document.body.appendChild(fab);
    if (on) renderP2lSupport();
  }

  function renderP2lSupport() {
    var fab = document.getElementById('p2l-support-fab');
    if (fab) fab.classList.toggle('has-unread', p2lSupportUnread > 0 && !p2lSupportOpen);
    var box = document.getElementById('p2l-support-box');
    if (!p2lSupportOpen) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('section');
      box.id = 'p2l-support-box';
      box.className = 'p2l-support';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Chat de soporte P2L');
      document.body.appendChild(box);
    }
    var company = (state.company && state.company.name) || 'tu empresa';
    var rows = p2lSupportRows.map(function (m) {
      return '<div class="p2l-support__row ' + (m.mine ? 'is-mine' : 'is-theirs') + '"><p>' + esc(m.text) + '</p></div>';
    }).join('');
    box.innerHTML =
      '<header class="p2l-support__head"><div><strong>Soporte P2L</strong><span>Devops · ' + esc(company) + '</span></div>' +
      '<button type="button" id="p2l-support-close" aria-label="Cerrar">×</button></header>' +
      '<div class="p2l-support__log" id="p2l-support-log">' +
      (rows || '<p class="p2l-support__empty">Escribe a soporte P2L. La respuesta llega por el mismo chat del Semantic IDE.</p>') +
      '</div>' +
      '<form class="p2l-support__form" id="p2l-support-form">' +
      '<input id="p2l-support-input" maxlength="2000" placeholder="Mensaje para soporte P2L" autocomplete="off" />' +
      '<button type="submit">Enviar</button></form>';
    var log = document.getElementById('p2l-support-log');
    if (log) log.scrollTop = log.scrollHeight;
    document.getElementById('p2l-support-close').addEventListener('click', function () {
      p2lSupportOpen = false;
      renderP2lSupport();
    });
    document.getElementById('p2l-support-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = document.getElementById('p2l-support-input');
      var text = input && input.value ? input.value.trim() : '';
      if (!text) return;
      sendP2lSupport(text);
      input.value = '';
    });
    var input = document.getElementById('p2l-support-input');
    if (input) input.focus();
  }

  function sendP2lSupport(text) {
    var me = p2lSupportMe();
    var room = p2lSupportRoom();
    var company = (state.company && state.company.name) || 'Empresa';
    var message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      text: text,
      from: me,
      to: P2L_SUPPORT_TO,
      fromName: company,
      fromProfile: 'techguard-wa-portal',
      chatId: room,
      roomId: room,
      timestamp: new Date().toISOString()
    };
    var payload = {
      message: message,
      from: me,
      to: P2L_SUPPORT_TO,
      text: text,
      chatId: room,
      roomId: room
    };
    var row = { id: message.id, text: text, mine: true, pending: true, payload: payload };
    p2lSupportRows.push(row);
    saveP2lSupportRows();
    renderP2lSupport();
    flushP2lSupport();
  }

  function onP2lSupportMessage(data) {
    if (!devopsChatEnabled()) return;
    var msg = (data && data.message) || data || {};
    var me = p2lSupportMe();
    var from = String(msg.from || (data && data.from) || '');
    var to = String(msg.to || (data && data.to) || '');
    if (!from || from === me) return;
    if (to && to !== me) return;
    var text = String(msg.text || '').trim();
    if (!text) return;
    if (msg.id && p2lSupportRows.some(function (row) { return row.id === msg.id; })) return;
    p2lSupportRows.push({ id: msg.id || ('in_' + Date.now()), text: text, mine: false });
    saveP2lSupportRows();
    if (!p2lSupportOpen) p2lSupportUnread += 1;
    if (document.getElementById('p2l-support-fab')) renderP2lSupport();
  }

  /* ── arranque ────────────────────────────────────────────────────────── */

  function boot() {
    mountP2lSupportChat(false);
    state.companyId = readCompanyId();
    if (!state.companyId) {
      $('#tg-root').className = 'tg-co';
      $('#tg-root').innerHTML =
        '<div class="tg-gate"><div class="tg-gate__card">' +
        '<p class="tg-gate__brand">P2L</p>' +
        '<p class="tg-gate__eyebrow">Panel de empresa</p>' +
        '<p class="tg-gate__lead">Este enlace no trae el identificador de tu empresa. ' +
        'Abre el enlace completo que te envió el cluster.</p></div></div>';
      return;
    }
    state.token = loadToken();
    if (!state.token) return renderGate('');
    $('#tg-root').innerHTML = '<p class="tg-loading">Cargando tu panel…</p>';
    api('/public/portal/session')
      .then(function (out) {
        state.company = out.company;
        state.connection = out.connection;
        renderPanel();
      })
      .catch(function () {
        saveToken('');
        state.token = '';
        renderGate('');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
