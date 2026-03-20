/* ═══════════════════════════════════════════════════════════
   BerBeck — Lógica da aplicação
   Depende de: config.js, supabase-js, xlsx
   ═══════════════════════════════════════════════════════════ */

// ── CONSTANTES ───────────────────────────────────────────────
const TIPOS = {
  pilsen:   { label: 'Pilsen',   emoji: '🟡', cls: 'pilsen' },
  pale_ale: { label: 'Pale Ale', emoji: '🟢', cls: 'pale_ale' },
  red:      { label: 'Red',      emoji: '🔴', cls: 'red' },
};

const CONSIG_STATUS = {
  pendente:        '🟣 Pendente',
  usado:           '✅ Usado',
  devolvido:       '↩️ Devolvido',
  nao_requisitado: '— Não Requisitado',
};

const STATUS_LABEL = {
  realizado: 'Realizado',
  pendente:  'Pendente',
  confirmar: 'A Confirmar',
  desistiu:  'Desistiu',
};

// ── STATE ────────────────────────────────────────────────────
let db;
let orders       = [];
let producoes    = [];
let currentFilter = 'todos';
let viewingId    = null;
let editingId    = null;
let itemRowCount = 0;

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
async function init() {
  db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data: { session } } = await db.auth.getSession();
  if (session) showApp(session.user);

  db.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_IN'  && session) showApp(session.user);
    if (ev === 'SIGNED_OUT')            showLogin();
  });
}

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPassword').value;
  if (!email || !pass) { showLoginError('Preencha e-mail e senha.'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Entrando...';
  document.getElementById('loginError').classList.remove('show');

  const { error } = await db.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'Entrar';
  if (error) showLoginError('E-mail ou senha incorretos.');
}

async function doLogout() {
  if (!confirm('Sair da conta?')) return;
  await db.auth.signOut();
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.classList.remove('show');
  void el.offsetWidth; // force reflow for shake animation
  el.classList.add('show');
}

function showApp(user) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  const email = user.email || '';
  document.getElementById('userAvatar').textContent = email.charAt(0).toUpperCase();
  document.getElementById('userEmail').textContent  = email.split('@')[0];
  loadData();
}

function showLogin() {
  document.getElementById('app').style.display         = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginEmail').value    = '';
  document.getElementById('loginPassword').value = '';
}

// ═══════════════════════════════════════════════════════════
//  DATA FETCHING
// ═══════════════════════════════════════════════════════════
async function loadData() {
  try {
    await Promise.all([fetchOrders(), fetchEstoque()]);
    setConn('online');

    db.channel('berbeck-v3')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' },          () => fetchOrders())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedido_itens' },     () => fetchOrders())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'estoque_producao' }, () => fetchEstoque())
      .subscribe();
  } catch(e) {
    setConn('offline');
    console.error(e);
  }
}

async function fetchOrders() {
  const { data, error } = await db
    .from('pedidos')
    .select('*, pedido_itens(*)')
    .order('data', { ascending: false })
    .order('id',   { ascending: false });
  if (error) { console.error(error); return; }
  orders = data || [];
  render();
  updateMonth();
  renderEstoque(); // estoque livre depends on orders
}

async function fetchEstoque() {
  const { data, error } = await db
    .from('estoque_producao')
    .select('*')
    .order('criado_em', { ascending: false });
  if (error) { console.error(error); return; }
  producoes = data || [];
  renderEstoque();
}

// ═══════════════════════════════════════════════════════════
//  ESTOQUE CALCULATIONS
// ═══════════════════════════════════════════════════════════
function calcEstoqueByTipo(tipo) {
  const produzido = producoes
    .filter(p => p.tipo === tipo)
    .reduce((s, p) => s + (p.litros || 0), 0);

  const consumido = orders.reduce((s, o) => {
    return s + (o.pedido_itens || []).reduce((si, it) => {
      if (it.tipo !== tipo) return si;
      let c = 0;
      if (o.status === 'realizado') c += (it.litros || 0);
      if (it.litros_consignado && it.status_consignado === 'usado') c += it.litros_consignado;
      return si + c;
    }, 0);
  }, 0);

  const now = new Date();
  const mes = now.getMonth(), ano = now.getFullYear();

  const comprometido = orders.reduce((s, o) => {
    if (!o.data) return s;
    const d = new Date(o.data + 'T12:00:00');
    if (d.getMonth() !== mes || d.getFullYear() !== ano) return s;
    return s + (o.pedido_itens || []).reduce((si, it) => {
      if (it.tipo !== tipo) return si;
      let c = 0;
      if (o.status === 'pendente' || o.status === 'confirmar') c += (it.litros || 0);
      if (it.litros_consignado && it.status_consignado === 'pendente') c += it.litros_consignado;
      return si + c;
    }, 0);
  }, 0);

  const total  = produzido - consumido;
  const livre  = total - comprometido;
  const pct    = total > 0 ? Math.max(0, Math.min(100, (livre / total) * 100)) : 0;
  const danger = livre < 0 || pct < 15;
  const warn   = !danger && pct < 35;

  return { total, comprometido, livre, pct, danger, warn };
}

// ═══════════════════════════════════════════════════════════
//  RENDER — ESTOQUE CARDS
// ═══════════════════════════════════════════════════════════
function renderEstoque() {
  const grid = document.getElementById('estoqueGrid');
  grid.innerHTML = Object.entries(TIPOS).map(([tipo, meta]) => {
    const { total, comprometido, livre, pct, danger, warn } = calcEstoqueByTipo(tipo);
    const freeClass = danger ? 'danger' : warn ? 'warn' : 'safe';
    const barClass  = danger ? 'danger' : warn ? 'warn' : meta.cls;

    return `
    <div class="est-card ${meta.cls}">
      <div class="est-card-header">
        <span class="est-type-badge ${meta.cls}">${meta.emoji} ${meta.label}</span>
        <button class="est-add-btn" onclick="openEstoqueModal('${tipo}')">+ Produção</button>
      </div>
      <div class="est-nums">
        <div class="est-num-block">
          <div class="est-num-val gold">${total}L</div>
          <div class="est-num-lbl">Total</div>
        </div>
        <div class="est-num-block">
          <div class="est-num-val warn">${comprometido}L</div>
          <div class="est-num-lbl">Comprom.</div>
        </div>
        <div class="est-num-block">
          <div class="est-num-val ${freeClass}">${livre}L</div>
          <div class="est-num-lbl">Livre</div>
        </div>
      </div>
      <div class="est-bar-track">
        <div class="est-bar-fill ${barClass}" style="width:${pct}%"></div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
//  RENDER — TABLE
// ═══════════════════════════════════════════════════════════
function render() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const rows = orders.filter(o => {
    const matchQ = !q
      || o.cliente.toLowerCase().includes(q)
      || (o.nota     || '').toLowerCase().includes(q)
      || (o.endereco || '').toLowerCase().includes(q);
    const matchF = currentFilter === 'todos' || o.status === currentFilter;
    return matchQ && matchF;
  });

  const tbody = document.getElementById('tbody');
  const msg   = document.getElementById('centerMsg');

  if (!rows.length) {
    tbody.innerHTML = '';
    msg.style.display = 'block';
    msg.innerHTML = '<div class="icon">🍺</div><p>Nenhum pedido encontrado</p>';
    return;
  }

  msg.style.display = 'none';
  tbody.innerHTML = rows.map(o => {
    const itens = o.pedido_itens || [];
    const tiposPills = itens.map(it =>
      `<span class="tipo-pill tp-${it.tipo}">${TIPOS[it.tipo]?.emoji} ${it.litros ? it.litros + 'L ' : ''}${TIPOS[it.tipo]?.label}</span>`
    ).join('');
    const totalL = itens.reduce((s, it) => s + (it.litros || 0), 0);

    return `
    <tr class="row" onclick="openView(${o.id})">
      <td><span class="date-cell">${fmtDate(o.data)}</span></td>
      <td>
        <div class="client-name">${esc(o.cliente)}</div>
        ${o.endereco ? `<div class="client-sub">📍 ${esc(o.endereco)}</div>` : ''}
      </td>
      <td>
        <div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center">
          ${tiposPills || '<span class="muted">—</span>'}
        </div>
        ${totalL ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-family:var(--font-label)">Total: ${totalL}L</div>` : ''}
      </td>
      <td>${statusBadge(o.status)}</td>
      <td>${o.chopeira ? '<span class="badge b-confirm">🍺 Sim</span>' : '<span class="muted">—</span>'}</td>
      <td>${pagoBadge(o.pago)}</td>
      <td>${o.valor ? `<span class="valor-cell">R$ ${parseFloat(o.valor).toFixed(2).replace('.', ',')}</span>` : '<span class="muted">—</span>'}</td>
      <td>${o.horario ? `<span class="time-tag">🕐 ${esc(o.horario)}</span>` : '<span class="muted">—</span>'}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap;display:flex;gap:5px;align-items:center;min-height:48px">
        ${o.status !== 'realizado' ? `<button class="btn btn-sm" onclick="quickDone(${o.id})">✅</button>` : ''}
        ${!o.pago ? `<button class="btn btn-sm btn-ghost" style="border-color:rgba(107,191,122,.4);color:var(--green)" onclick="quickPago(${o.id})" title="Marcar como Pago">💰</button>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openEditModal(${o.id})">✏️</button>
      </td>
    </tr>`;
  }).join('');
}

function updateStats() {
  const now = new Date();
  const mes = now.getMonth(), ano = now.getFullYear();

  const thisMonth = orders.filter(o => {
    if (!o.data) return false;
    const d = new Date(o.data + 'T12:00:00');
    return d.getMonth() === mes && d.getFullYear() === ano;
  });

  // All month-scoped calculations use thisMonth for consistency with the estoque comprometido calc
  const totalL   = thisMonth.reduce((s, o) => s + (o.pedido_itens || []).reduce((si, it) => si + (it.litros || 0), 0), 0);
  const consigP  = thisMonth.reduce((s, o) => s + (o.pedido_itens || [])
    .filter(it => it.litros_consignado && it.status_consignado === 'pendente')
    .reduce((si, it) => si + (it.litros_consignado || 0), 0), 0);
  const valorTotal = thisMonth.reduce((s, o) => s + (parseFloat(o.valor) || 0), 0);

  document.getElementById('sTotal').textContent  = thisMonth.length;
  document.getElementById('sLitros').textContent = totalL + 'L';
  document.getElementById('sFeitos').textContent = thisMonth.filter(o => o.status === 'realizado').length;
  document.getElementById('sConsig').textContent = consigP + 'L';
  document.getElementById('sValor').textContent  = 'R$' + valorTotal.toFixed(0);
}

function updateMonth() {
  const dates = orders.map(o => o.data).filter(Boolean).sort();
  if (!dates.length) return;
  const d = new Date(dates[dates.length - 1] + 'T12:00:00');
  document.getElementById('hMonth').textContent =
    d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
     .replace(/^\w/, c => c.toUpperCase());
}

function setFilter(f, el) {
  currentFilter = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  render();
}

// ═══════════════════════════════════════════════════════════
//  VIEW MODAL
// ═══════════════════════════════════════════════════════════
function openView(id) {
  viewingId = id;
  const o = orders.find(x => x.id === id);
  if (!o) return;

  const itens = o.pedido_itens || [];
  document.getElementById('viewTitle').textContent = o.cliente;

  let html = `
    <div class="view-section">
      <div class="view-section-title">Informações Gerais</div>
      <div class="view-row"><span class="view-lbl">Data</span><span class="view-val">${fmtDateFull(o.data)}</span></div>
      <div class="view-row"><span class="view-lbl">Status</span><span class="view-val">${statusBadge(o.status)}</span></div>
      ${o.endereco ? `<div class="view-row"><span class="view-lbl">Endereço</span><span class="view-val">📍 ${esc(o.endereco)}</span></div>` : ''}
      ${o.horario  ? `<div class="view-row"><span class="view-lbl">Horário</span><span class="view-val">🕐 ${esc(o.horario)}</span></div>` : ''}
      <div class="view-row"><span class="view-lbl">Chopeira</span><span class="view-val">${o.chopeira ? '🍺 Sim' : 'Não'}</span></div>
      ${o.valor ? `<div class="view-row"><span class="view-lbl">Valor</span><span class="view-val accent">R$ ${parseFloat(o.valor).toFixed(2).replace('.', ',')}</span></div>` : ''}
      <div class="view-row"><span class="view-lbl">Pagamento</span><span class="view-val">${o.pago ? '<span class="badge b-done">💰 Pago</span>' : '<span class="badge b-cancel">⏳ Não Pago</span>'}</span></div>
      ${o.nota  ? `<div class="view-row"><span class="view-lbl">Notas</span><span class="view-val">${esc(o.nota)}</span></div>` : ''}
    </div>`;

  if (itens.length) {
    html += `<div class="view-section"><div class="view-section-title">Itens de Chopp</div>`;
    itens.forEach(it => {
      const t = TIPOS[it.tipo] || {};
      html += `
      <div class="item-card">
        <div class="item-card-header">
          <span class="tipo-pill tp-${it.tipo}">${t.emoji} ${t.label}</span>
          ${it.litros ? `<span style="font-family:var(--font-label);font-weight:700;color:var(--gold-light)">${it.litros}L</span>` : ''}
        </div>
        ${it.litros_consignado ? `
        <div class="item-detail-row">
          <div class="item-detail-cell">
            <span class="item-detail-lbl">Consignado</span>
            <span class="item-detail-val">🟣 ${it.litros_consignado}L</span>
          </div>
          <div class="item-detail-cell">
            <span class="item-detail-lbl">Status Consig.</span>
            <span class="item-detail-val">${CONSIG_STATUS[it.status_consignado] || '—'}</span>
          </div>
        </div>` : ''}
      </div>`;
    });
    html += '</div>';

    const totalL = itens.reduce((s, it) => s + (it.litros || 0), 0);
    const totalC = itens.reduce((s, it) => s + (it.litros_consignado || 0), 0);
    if (totalL) html += `<div class="view-row"><span class="view-lbl">Total Fixo</span><span class="view-val accent">${totalL}L</span></div>`;
    if (totalC) html += `<div class="view-row"><span class="view-lbl">Total Consignado</span><span class="view-val" style="color:var(--purple)">${totalC}L</span></div>`;
  }

  document.getElementById('viewBody').innerHTML = html;
  document.getElementById('overlayView').classList.add('open');
}

function closeView()      { document.getElementById('overlayView').classList.remove('open'); viewingId = null; }
function editFromView()   { const id = viewingId; closeView(); openEditModal(id); }
function deleteFromView() { const id = viewingId; closeView(); openEditModal(id); setTimeout(deleteOrder, 100); }

// ═══════════════════════════════════════════════════════════
//  EDIT MODAL
// ═══════════════════════════════════════════════════════════
function openEditModal(id) {
  editingId = id || null;
  document.getElementById('editTitle').textContent    = id ? 'Editar Pedido' : 'Novo Pedido';
  document.getElementById('editDelBtn').style.display = id ? 'inline-flex' : 'none';
  document.getElementById('itemRows').innerHTML = '';
  itemRowCount = 0;

  if (id) {
    const o = orders.find(x => x.id === id);
    if (!o) return;
    document.getElementById('fData').value       = o.data     || '';
    document.getElementById('fCliente').value    = o.cliente  || '';
    document.getElementById('fStatus').value     = o.status   || 'pendente';
    document.getElementById('fHorario').value    = o.horario  || '';
    document.getElementById('fNota').value       = o.nota     || '';
    document.getElementById('fEndereco').value   = o.endereco || '';
    document.getElementById('fValor').value      = o.valor    || '';
    document.getElementById('fChopeira').checked = !!o.chopeira;
    document.getElementById('fPago').checked     = !!o.pago;
    (o.pedido_itens || []).forEach(it => addItemRow(it));
  } else {
    document.getElementById('fData').value       = today();
    document.getElementById('fCliente').value    = '';
    document.getElementById('fStatus').value     = 'pendente';
    document.getElementById('fHorario').value    = '';
    document.getElementById('fNota').value       = '';
    document.getElementById('fEndereco').value   = '';
    document.getElementById('fValor').value      = '';
    document.getElementById('fChopeira').checked = false;
    document.getElementById('fPago').checked     = false;
    addItemRow(); // one empty row to start
  }

  document.getElementById('overlayEdit').classList.add('open');
  setTimeout(() => document.getElementById('fCliente').focus(), 80);
}

function closeEdit() {
  document.getElementById('overlayEdit').classList.remove('open');
  editingId = null;
}

function addItemRow(data = null) {
  const rowId     = ++itemRowCount;
  const container = document.getElementById('itemRows');
  const div       = document.createElement('div');
  div.className = 'item-row';
  div.id        = 'ir-' + rowId;
  div.innerHTML = `
    <div>
      <div class="item-row-label">Tipo</div>
      <select class="sel inp-sm" id="ir-tipo-${rowId}">
        <option value="pilsen"   ${data?.tipo === 'pilsen'   ? 'selected' : ''}>🟡 Pilsen</option>
        <option value="pale_ale" ${data?.tipo === 'pale_ale' ? 'selected' : ''}>🟢 Pale Ale</option>
        <option value="red"      ${data?.tipo === 'red'      ? 'selected' : ''}>🔴 Red</option>
      </select>
    </div>
    <div>
      <div class="item-row-label">Litros</div>
      <input type="number" class="inp inp-sm" id="ir-litros-${rowId}"
        value="${data?.litros || ''}" placeholder="L" min="1">
    </div>
    <div>
      <div class="item-row-label">Consig.</div>
      <input type="number" class="inp inp-sm" id="ir-consig-${rowId}"
        value="${data?.litros_consignado || ''}" placeholder="L" min="1"
        oninput="onConsigChange(${rowId})">
    </div>
    <div>
      <div class="item-row-label">St. Consig.</div>
      <select class="sel inp-sm consig-status-sel ${data?.litros_consignado ? 'show' : ''}" id="ir-cstt-${rowId}">
        <option value="pendente"        ${data?.status_consignado === 'pendente'        ? 'selected' : ''}>🟣 Pendente</option>
        <option value="usado"           ${data?.status_consignado === 'usado'           ? 'selected' : ''}>✅ Usado</option>
        <option value="devolvido"       ${data?.status_consignado === 'devolvido'       ? 'selected' : ''}>↩️ Devolvido</option>
        <option value="nao_requisitado" ${data?.status_consignado === 'nao_requisitado' ? 'selected' : ''}>— Não Req.</option>
      </select>
    </div>
    <button class="remove-item-btn" onclick="removeItemRow(${rowId})" title="Remover">✕</button>
  `;
  container.appendChild(div);
}

function removeItemRow(id) {
  const el = document.getElementById('ir-' + id);
  if (el) el.remove();
}

function onConsigChange(id) {
  const val = document.getElementById('ir-consig-' + id).value;
  document.getElementById('ir-cstt-' + id).classList.toggle('show', !!val);
}

function getItemRows() {
  return Array.from(document.querySelectorAll('.item-row')).map(row => {
    const id = row.id.replace('ir-', '');
    return {
      tipo:              document.getElementById('ir-tipo-'   + id)?.value,
      litros:            parseInt(document.getElementById('ir-litros-' + id)?.value) || null,
      litros_consignado: parseInt(document.getElementById('ir-consig-' + id)?.value) || null,
      status_consignado: document.getElementById('ir-cstt-'  + id)?.value || 'pendente',
    };
  }).filter(r => r.tipo);
}

async function saveOrder() {
  const cliente = document.getElementById('fCliente').value.trim();
  if (!cliente) { toast('⚠️ Informe o nome do cliente'); return; }

  const itens = getItemRows();
  if (!itens.length) { toast('⚠️ Adicione ao menos um tipo de chopp'); return; }

  const pedido = {
    data:     document.getElementById('fData').value         || null,
    cliente,
    status:   document.getElementById('fStatus').value,
    horario:  document.getElementById('fHorario').value.trim()  || null,
    nota:     document.getElementById('fNota').value.trim()     || null,
    endereco: document.getElementById('fEndereco').value.trim() || null,
    valor:    parseFloat(document.getElementById('fValor').value) || null,
    chopeira: document.getElementById('fChopeira').checked,
    pago:     document.getElementById('fPago').checked,
  };

  setBusy('saveBtn', true);

  let pedidoId = editingId;
  let error;

  if (editingId) {
    ({ error } = await db.from('pedidos').update(pedido).eq('id', editingId));
    if (!error) {
      await db.from('pedido_itens').delete().eq('pedido_id', editingId);
    }
  } else {
    const { data, error: e } = await db.from('pedidos').insert(pedido).select().single();
    error = e;
    if (data) pedidoId = data.id;
  }

  if (!error && pedidoId) {
    const itemsToInsert = itens.map(it => ({ ...it, pedido_id: pedidoId }));
    ({ error } = await db.from('pedido_itens').insert(itemsToInsert));
  }

  setBusy('saveBtn', false);
  if (error) { toast('❌ Erro: ' + error.message); return; }

  toast(editingId ? '✅ Pedido atualizado!' : '🍺 Pedido adicionado!');
  closeEdit();
  await fetchOrders();
}

async function deleteOrder() {
  if (!editingId || !confirm('Excluir este pedido?')) return;
  const { error } = await db.from('pedidos').delete().eq('id', editingId);
  if (error) { toast('❌ Erro ao excluir'); return; }
  toast('🗑️ Pedido excluído');
  closeEdit();
  await fetchOrders();
}

async function quickDone(id) {
  const { error } = await db.from('pedidos').update({ status: 'realizado' }).eq('id', id);
  if (!error) { toast('✅ Realizado!'); await fetchOrders(); }
}

// ═══════════════════════════════════════════════════════════
//  ESTOQUE MODAL
// ═══════════════════════════════════════════════════════════
function openEstoqueModal(tipo) {
  const meta = TIPOS[tipo];
  document.getElementById('estModalTitle').textContent = `+ Produção — ${meta.label}`;
  document.getElementById('fEstTipo').value  = tipo;
  document.getElementById('fEstLitros').value = '';
  document.getElementById('fEstNota').value   = '';

  const { total, comprometido, livre } = calcEstoqueByTipo(tipo);
  document.getElementById('estModalInfo').innerHTML = `
    <div class="est-modal-row"><span>Estoque atual (${meta.label})</span><span>${total}L</span></div>
    <div class="est-modal-row"><span>Comprometido este mês</span><span>${comprometido}L</span></div>
    <div class="est-modal-row">
      <span style="font-weight:600;color:var(--text)">Livre</span>
      <span class="est-modal-total">${livre}L</span>
    </div>`;

  document.getElementById('overlayEstoque').classList.add('open');
  setTimeout(() => document.getElementById('fEstLitros').focus(), 80);
}

function closeEstoqueModal() {
  document.getElementById('overlayEstoque').classList.remove('open');
}

async function saveEstoque() {
  const litros = parseInt(document.getElementById('fEstLitros').value);
  if (!litros || litros < 1) { toast('⚠️ Informe a quantidade'); return; }

  const tipo = document.getElementById('fEstTipo').value;
  const nota = document.getElementById('fEstNota').value.trim() || null;

  setBusy('savEstBtn', true);
  const { error } = await db.from('estoque_producao').insert({ tipo, litros, nota });
  setBusy('savEstBtn', false);

  if (error) { toast('❌ Erro: ' + error.message); return; }
  toast(`🏭 +${litros}L de ${TIPOS[tipo].label} registrado!`);
  closeEstoqueModal();
  await fetchEstoque();
}

function openHistorico() {
  closeEstoqueModal();
  const list = document.getElementById('historicoList');

  if (!producoes.length) {
    list.innerHTML = '<div class="center-msg"><div class="icon">📋</div><p>Nenhum registro ainda</p></div>';
  } else {
    list.innerHTML = producoes.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="tipo-pill tp-${p.tipo}">${TIPOS[p.tipo]?.emoji} ${TIPOS[p.tipo]?.label}</span>
            <span style="font-weight:600;color:var(--text)">+${p.litros}L</span>
          </div>
          ${p.nota ? `<div style="font-size:12px;color:var(--text-muted);font-style:italic;margin-top:4px">${esc(p.nota)}</div>` : ''}
        </div>
        <div style="font-family:var(--font-label);font-size:12px;color:var(--text-muted)">${fmtDateTime(p.criado_em)}</div>
      </div>`).join('');
  }

  document.getElementById('overlayHistorico').classList.add('open');
}

function closeHistorico() { document.getElementById('overlayHistorico').classList.remove('open'); }

// ═══════════════════════════════════════════════════════════
//  EXPORT EXCEL
// ═══════════════════════════════════════════════════════════
function openExportModal() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('fExportDe').value  = `${y}-${m}-01`;
  document.getElementById('fExportAte').value = `${y}-${m}-31`;
  document.getElementById('overlayExport').classList.add('open');
}

function closeExport() { document.getElementById('overlayExport').classList.remove('open'); }

function exportExcel() {
  const de  = document.getElementById('fExportDe').value;
  const ate = document.getElementById('fExportAte').value;

  let filtered = orders;
  if (de)  filtered = filtered.filter(o => o.data && o.data >= de);
  if (ate) filtered = filtered.filter(o => o.data && o.data <= ate);

  if (!filtered.length) { toast('⚠️ Nenhum pedido no período'); return; }

  const rows = filtered.map(o => {
    const itens    = o.pedido_itens || [];
    const pilsen   = itens.find(it => it.tipo === 'pilsen');
    const pale_ale = itens.find(it => it.tipo === 'pale_ale');
    const red      = itens.find(it => it.tipo === 'red');
    const totalL   = itens.reduce((s, it) => s + (it.litros || 0), 0);
    const totalC   = itens.reduce((s, it) => s + (it.litros_consignado || 0), 0);

    return {
      'Data':                 fmtDateFull(o.data),
      'Cliente':              o.cliente,
      'Status':               STATUS_LABEL[o.status] || o.status,
      'Endereço':             o.endereco || '',
      'Chopeira':             o.chopeira ? 'Sim' : 'Não',
      'Pilsen (L)':           pilsen?.litros              || '',
      'Pale Ale (L)':         pale_ale?.litros            || '',
      'Red (L)':              red?.litros                 || '',
      'Total Litros':         totalL                      || '',
      'Consig. Pilsen (L)':   pilsen?.litros_consignado   || '',
      'Consig. Pale Ale (L)': pale_ale?.litros_consignado || '',
      'Consig. Red (L)':      red?.litros_consignado      || '',
      'Total Consig.':        totalC                      || '',
      'Horário':              o.horario || '',
      'Valor (R$)':           o.valor ? parseFloat(o.valor).toFixed(2) : '',
      'Notas':                o.nota   || '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pedidos');

  ws['!cols'] = [
    { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 30 }, { wch: 10 },
    { wch: 12 }, { wch: 13 }, { wch: 10 }, { wch: 13 },
    { wch: 16 }, { wch: 19 }, { wch: 16 }, { wch: 14 },
    { wch: 16 }, { wch: 12 }, { wch: 24 },
  ];

  const filename = `berbeck-pedidos${de ? '-' + de : ''}${ate ? '-ate-' + ate : ''}.xlsx`;
  XLSX.writeFile(wb, filename);
  toast('📊 Excel gerado!');
  closeExport();
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

async function quickPago(id) {
  const { error } = await db.from('pedidos').update({ pago: true }).eq('id', id);
  if (!error) { toast('💰 Pagamento confirmado!'); await fetchOrders(); }
}

function statusBadge(s) {
  const m = {
    realizado: ['b-done',    '✅ Realizado'],
    pendente:  ['b-pending', '⏳ Pendente'],
    confirmar: ['b-confirm', '❓ A Confirmar'],
    desistiu:  ['b-cancel',  '❌ Desistiu'],
  };
  const [cls, lbl] = m[s] || ['b-pending', s];
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function pagoBadge(pago) {
  return pago
    ? `<span class="badge b-done">✅ Pago</span>`
    : `<span class="badge b-unpaid">⚠️ Não Pago</span>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

function fmtDateFull(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function today() { return new Date().toISOString().split('T')[0]; }

function setConn(state) {
  const el = document.getElementById('connPill');
  el.className = 'conn-pill ' + state;
  document.getElementById('connLabel').textContent = state === 'online' ? 'Online' : 'Offline';
}

function setBusy(btnId, busy) {
  const btn = document.getElementById(btnId);
  btn.disabled    = busy;
  btn.textContent = busy ? 'Salvando...' : 'Salvar';
}

let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ═══════════════════════════════════════════════════════════
//  KEYBOARD & OVERLAY CLOSE
// ═══════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const loginVisible = document.getElementById('loginScreen').style.display !== 'none';
  if (e.key === 'Enter' && loginVisible) { doLogin(); return; }
  if (e.key === 'Escape') {
    closeView();
    closeEdit();
    closeEstoqueModal();
    closeHistorico();
    closeExport();
  }
});

['overlayView', 'overlayEdit', 'overlayEstoque', 'overlayHistorico', 'overlayExport'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target === document.getElementById(id)) {
      document.getElementById(id).classList.remove('open');
    }
  });
});

// ── START ──
init();