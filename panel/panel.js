/**
 * Panel de empresa TechGuard — versión estática para GitHub Pages.
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
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<div class="tg-gate"><div class="tg-gate__card">' +
      '<p class="tg-gate__brand">Tech<em>Guard</em></p>' +
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

  function renderPanel() {
    var c = state.company;
    document.title = (c.name || 'Empresa') + ' · Bot WhatsApp IA';
    var conn = state.connection;
    var b = c.brand || {};
    var root = $('#tg-root');
    root.className = 'tg-co';
    root.innerHTML =
      '<header class="tg-co__header"><div class="tg-co__title">' +
      '<p class="tg-co__eyebrow">' + esc(c.name || 'Empresa') + ' · Bot WhatsApp IA</p>' +
      '<h1>' + esc(c.name || 'Empresa') + '</h1>' +
      '<div class="tg-co__meta"><span class="tg-muted">Plan ' +
      esc((c.planSpec && c.planSpec.name) || c.plan) + ' · WA ' + esc(c.waManagedBy) + ' · ' +
      esc(c.subscriptionStatus) + '</span></div></div>' +
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
      '<textarea id="tg-skill" class="tg-area tg-area--fill"></textarea>' +
      '<p id="tg-skill-lock" class="tg-muted" hidden>El cluster asignó este skill. La empresa no puede cambiarlo.</p></div>' +
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
    $('#tg-skill').readOnly = !!c.skillLocked;
    var lockNote = $('#tg-skill-lock');
    if (lockNote) lockNote.hidden = !c.skillLocked;
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
    bindCopy('#tg-copy-webhook', '#tg-wa-webhook', 'Webhook copiado. Pégalo en «URL de devolución de llamada» en Meta');
    bindCopy('#tg-copy-verify', '#tg-wa-verify', 'Verify token copiado. Pégalo en el Paso 2 de developers.facebook.com');
    startChatLive();
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
    var body = {
        flows: flows,
        productCapabilities: productCapabilities,
        mcpServers: mcp ? [{ name: 'mcp', type: 'sse', url: mcp }] : [],
        paymentLinks: pay ? [{ label: 'Pago', url: pay }] : []
    };
    if (!(state.company && state.company.skillLocked)) {
      body.skills = [{ path: 'negocio.md', content: $('#tg-skill').value }];
    }
    api('/public/portal/company', {
      method: 'PATCH',
      body: body
    }).then(afterSave).catch(onError);
  }

  function saveWa() {
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

  /* ── arranque ────────────────────────────────────────────────────────── */

  function boot() {
    state.companyId = readCompanyId();
    if (!state.companyId) {
      $('#tg-root').className = 'tg-co';
      $('#tg-root').innerHTML =
        '<div class="tg-gate"><div class="tg-gate__card">' +
        '<p class="tg-gate__brand">Tech<em>Guard</em></p>' +
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
