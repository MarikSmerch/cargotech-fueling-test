/* CargoTech «Заправка в рейсе». Без библиотек и изменений fake-api.js. */
(() => {
  'use strict';

  const api = window.FakeApi;
  const root = document.getElementById('app');
  const STORAGE = 'cargotech.fueling.client.v1';
  const ALPHABET = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'; // Допущение для «Колеса» после Г.
  const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const saved = loadSaved();
  const app = {
    screen: 'loading', busy: false, trip: null, location: null, stations: [],
    station: null, fuel: 'diesel', pump: null, liters: 100,
    search: '', sorting: 'distance', visibleCount: 12, showLimitHelp: false,
    fueling: null, connectionError: false, notice: '', noticeType: 'orange',
    session: saved, confirmedLimit: true, limitLoading: false, pendingChecked: false
  };
  let polling = false;
  let lastRecover = 0;

  function loadSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE));
      return value && typeof value === 'object' ? value : { pending: null, fuelingId: null };
    } catch (_) { return { pending: null, fuelingId: null }; }
  }
  function saveSaved() {
    try { localStorage.setItem(STORAGE, JSON.stringify(app.session)); } catch (_) { /* private mode */ }
  }
  function html(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function money(amount) { return Number.isFinite(Number(amount)) ? rub.format(Number(amount)) + ' ₽' : '—'; }
  function litres(n) { return Number.isFinite(Number(n)) ? rub.format(Number(n)) + ' л' : '—'; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function amount() { return Math.round(app.liters * price() * 100) / 100; }
  function price() { return app.station?.fuels.find(f => f.code === app.fuel)?.price ?? 0; }
  function maxLiters() {
    if (!app.station || !app.trip || price() <= 0) return 0;
    const availableKopecks = Math.round(app.trip.limitLeft * 100);
    const priceKopecks = Math.round(price() * 100);
    return Math.min(app.station.litersMax, Math.floor(availableKopecks / priceKopecks * 100) / 100);
  }
  function validLiters() {
    return Number.isFinite(app.liters) && app.liters >= app.station.litersMin && app.liters <= maxLiters() && Math.abs(app.liters * 100 - Math.round(app.liters * 100)) < 0.00001;
  }
  function distance(a, b) {
    if (!a || !b) return Infinity;
    const d2r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * d2r;
    const dLon = (b.lon - a.lon) * d2r;
    const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(q)));
  }
  function pumpName(number) {
    const isKoleso = app.station?.brand === 'Колесо' || app.fueling?.stationName?.startsWith('Колесо');
    return isKoleso && number >= 1 && number <= ALPHABET.length
      ? `${ALPHABET[number - 1]} (№${number})` : `№${number}`;
  }
  function statusText(status) {
    return ({accepted:'Заказ принят',waiting_nozzle:'Ожидание пистолета',fueling:'Идёт заправка',completed:'Заправка завершена',cancelled:'Заправка отменена'})[status] || status;
  }
  function cancelReason(code) {
    return ({PUMP_TIMEOUT:'Не удалось начать заправку вовремя.',STATION_NO_RESPONSE:'АЗС не подтвердила заказ.',DRIVER_CANCELLED:'Заказ отменён до начала налива.'})[code] || 'Заправка не состоялась.';
  }
  function clearNotice() { app.notice = ''; }
  function setNotice(text, type = 'orange') { app.notice = text; app.noticeType = type; }
  function alertMarkup() {
    return app.notice ? `<div class="note ${app.noticeType === 'red' ? 'red' : 'orange'}" role="alert"><span class="sym">ⓘ</span><div>${html(app.notice)}</div></div>` : '';
  }
  function netMarkup() {
    return app.connectionError ? `<div class="note red" role="status"><span class="sym">!</span><div>Не удалось получить ответ от сервиса. Заправка может продолжаться на АЗС. Не создавайте новый заказ.</div></div>` : '';
  }
  function shell(inner, actions = '', back = '', step = '') {
    const canBack = back && !app.busy;
    return `<header class="top">${canBack ? `<button class="back" data-action="${back}" aria-label="Назад">←</button>` : ''}<div><div class="top-label">CargoTech · Заправка в рейсе</div><div class="top-name">${step || 'Водитель'}</div></div>${app.connectionError ? '<div class="signal bad">● Нет ответа</div>' : ''}</header><main class="main">${inner}</main>${actions ? `<footer class="foot">${actions}</footer>` : ''}`;
  }
  function button(label, action, { disabled = false, secondary = false } = {}) {
    return `<button class="btn ${secondary ? 'alt' : ''}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  }
  function render() {
    let body = '';
    switch (app.screen) {
      case 'loading':
        body = shell(`<div class="loading" aria-hidden="true"></div><p class="muted" style="text-align:center">Загружаем данные рейса…</p>`);
        break;
      case 'fatal':
        body = shell(`<h1 class="title">Не удалось загрузить рейс</h1><p class="muted">Проверьте связь и повторите запрос.</p>${alertMarkup()}`, button('Повторить загрузку', 'boot'));
        break;
      case 'home':
        body = homeScreen(); break;
      case 'stations':
        body = stationsScreen(); break;
      case 'station_loading':
        body = shell(`<div class="loading"></div><p class="muted" style="text-align:center">Загружаем АЗС…</p>${alertMarkup()}`, '', 'back-stations', 'Выбор АЗС'); break;
      case 'station':
        body = stationScreen(); break;
      case 'volume':
        body = volumeScreen(); break;
      case 'confirm':
        body = confirmScreen(); break;
      case 'sending':
        body = shell(`<div class="loading"></div><h1 class="title" style="text-align:center">Отправляем заказ</h1><p class="muted" style="text-align:center">Не нажимайте повторно. Проверяем ответ АЗС.</p>`); break;
      case 'recovery':
        body = shell(`<div class="center"><span class="symbol wait">↻</span><h1 class="title">Уточняем статус заказа</h1><p>Ответ от АЗС не получен. Заказ мог быть принят, даже если связь прервалась.</p><p class="muted small">Не оформляйте другую заправку, пока не проверите эту.</p></div>${app.pendingChecked ? '<div class="note orange"><span class="sym">ⓘ</span><div>Активная заправка не найдена. Повтор может вернуть ранее созданный заказ или оформить новый, если первый запрос не дошёл. Повторяйте только находясь на АЗС.</div></div>' : ''}${alertMarkup()}`, button('Проверить состояние', 'check-pending', {disabled:app.busy}) + (app.pendingChecked ? button('Повторить запрос', 'recover', {secondary:true,disabled:app.busy}) : ''), '', 'Проверка заказа');
        break;
      case 'progress':
        body = progressScreen(); break;
      case 'result':
        body = resultScreen(); break;
    }
    root.innerHTML = body;
  }
  function homeScreen() {
    const t = app.trip;
    const pct = Math.max(0, Math.min(100, t.limitLeft / t.limitTotal * 100));
    return shell(`<h1 class="title">Заправка в рейсе</h1>
      <div class="card"><div class="muted small">Текущий рейс · ${html(t.date)}</div><div class="route">${html(t.from)} → ${html(t.to)}</div><div class="muted small">Тягач ${html(t.truck)}</div></div>
      <div class="card"><div class="muted small">Доступный лимит на топливо</div><div class="big" style="margin:9px 0">${money(t.limitLeft)}</div><div class="muted small">из ${money(t.limitTotal)} на рейс</div><div class="progressbar"><span style="width:${pct}%"></span></div></div>
      <button class="helper" data-action="toggle-limit-help" aria-expanded="${app.showLimitHelp}">Почему доступная сумма может быть меньше? ${app.showLimitHelp ? '−' : '+'}</button>
      ${app.showLimitHelp ? '<div class="note"><span class="sym">ⓘ</span><div>На остаток влияют предыдущие списания и возможные блокировки. Если сумма непонятна, уточните её у диспетчера.</div></div>' : ''}${alertMarkup()}`,
      button('Заправиться', 'open-stations') + `<div class="foot-label">Оплата из лимита компании</div>`);
  }
  function preparedStations() {
    const q = app.search.trim().toLowerCase();
    return app.stations.filter(s =>
      s.prices.diesel != null &&
      (!q || `${s.name} ${s.address} ${s.brand}`.toLowerCase().includes(q))
    ).sort((a, b) => app.sorting === 'price'
      ? a.prices.diesel - b.prices.diesel || a.km - b.km
      : a.km - b.km);
  }
  function stationsItems() {
    const list = preparedStations();
    if (!list.length) return `<div class="note">Подходящие АЗС не найдены. Измените поиск.</div>`;
    const elements = list.slice(0, app.visibleCount).map(s => `<button class="station-item" data-action="choose-station" data-id="${html(s.id)}">
      <span class="list-top"><span class="station-title">${html(s.name)}</span><span class="price">${money(s.prices.diesel)}<span class="tiny muted">/л</span></span></span>
      <span class="muted small" style="display:block;margin-top:6px">${html(s.address)}</span><span class="small bold" style="display:block;margin-top:9px">≈ ${rub.format(s.km)} км по прямой · дизель</span>
      </button>`).join('');
    return elements + (app.visibleCount < list.length ? `<button class="btn alt" data-action="show-more">Показать ещё (${list.length - app.visibleCount})</button>` : '');
  }
  function stationsScreen() {
    return shell(`<div class="steps">Шаг 1 из 4</div><h1 class="title">Выберите АЗС</h1>
      <p class="muted small">Расстояния приблизительные, по прямой.</p>
      <input class="search" id="station-search" type="search" placeholder="Название или город" aria-label="Найти АЗС" value="${html(app.search)}">
      <div class="tabs"><button data-action="sort-distance" class="${app.sorting === 'distance' ? 'active' : ''}">Ближе</button><button data-action="sort-price" class="${app.sorting === 'price' ? 'active' : ''}">Дешевле</button></div>
      <div id="station-items">${stationsItems()}</div>${alertMarkup()}`, '', 'back-home', 'АЗС с дизелем');
  }
  function stationScreen() {
    const s = app.station;
    const fuels = s.fuels.map(f => `<button class="choice ${app.fuel === f.code ? 'selected' : ''}" data-action="choose-fuel" data-fuel="${html(f.code)}"><span class="space"><strong>${html(f.name)}</strong><strong>${money(f.price)}/л</strong></span></button>`).join('');
    const pumps = s.pumps.map(p => {
      const enabled = p.status === 'free' && p.fuels.includes(app.fuel);
      const desc = p.status === 'busy' ? 'Занята' : p.status === 'off' ? 'Не работает' : !p.fuels.includes(app.fuel) ? 'Нет выбранного топлива' : 'Свободна';
      return `<button class="choice ${app.pump === p.number ? 'selected' : ''}" data-action="choose-pump" data-pump="${p.number}" ${enabled ? '' : 'disabled'}><span class="space"><strong>Колонка ${pumpName(p.number)}</strong><span class="pill ${enabled ? 'ok' : p.status === 'off' ? 'bad' : 'gray'}">${desc}</span></span></button>`;
    }).join('');
    return shell(`<div class="steps">Шаг 2 из 4</div><h1 class="title">Топливо и колонка</h1><div class="card"><strong>${html(s.name)}</strong><div class="muted small" style="margin-top:5px">${html(s.address)}</div></div>
      <h2 class="subtitle">Выберите топливо</h2>${fuels}<h2 class="subtitle">Колонка, у которой стоите</h2>${pumps}${alertMarkup()}`,
      button('Продолжить', 'open-volume', { disabled: app.pump == null }), 'back-stations', 'Выбор топлива');
  }
  function volumeScreen() {
    const max = maxLiters();
    const enough = max >= app.station.litersMin;
    const err = !enough ? `Доступного лимита недостаточно для минимальной заправки ${app.station.litersMin} л. Уточните лимит у диспетчера.` :
      !validLiters() ? `Укажите объём от ${app.station.litersMin} до ${max} л (точность до 0,01 л).` : '';
    return shell(`<div class="steps">Шаг 3 из 4</div><h1 class="title">Сколько заправить?</h1>
      <div class="card"><div class="space"><span class="muted small">Топливо</span><strong>${html(app.station.fuels.find(f => f.code === app.fuel)?.name)}</strong></div><div class="space" style="margin-top:8px"><span class="muted small">Цена</span><strong>${money(price())}/л</strong></div><div class="space" style="margin-top:8px"><span class="muted small">Колонка</span><strong>${pumpName(app.pump)}</strong></div></div>
      <div class="muted small" style="margin-bottom:9px">Объём, литров</div><div class="stepper"><button class="sq" data-action="less" aria-label="Минус 10 литров">−</button><input class="field" type="text" id="liters" aria-label="Количество литров" inputmode="decimal" value="${Number.isFinite(app.liters) ? html(app.liters) : ''}"><button class="sq" data-action="more" aria-label="Плюс 10 литров">+</button></div>
      <div class="quick"><button data-action="max-liters">Доступный максимум: ${max} л</button></div>
      <p class="muted small">Ограничение АЗС: ${app.station.litersMin}–${app.station.litersMax} л · доступно ${money(app.trip.limitLeft)}</p>
      <div class="card"><div class="muted small">Стоимость заказа</div><div class="big" style="margin-top:8px">${validLiters() ? money(amount()) : '—'}</div><div class="muted small" style="margin-top:5px">Сумма будет временно зарезервирована</div></div>
      ${err ? `<div class="note red"><span class="sym">!</span><div>${html(err)}</div></div>` : ''}${alertMarkup()}`,
      button('Проверить заказ', 'open-confirm', { disabled: !validLiters() }), 'back-station', 'Объём заправки');
  }
  function confirmScreen() {
    const invalid = !validLiters();
    return shell(`<div class="steps">Шаг 4 из 4</div><h1 class="title">Подтвердите заказ</h1><div class="card white-card">
      <div class="bold" style="font-size:18px">${html(app.station.name)}</div><div class="muted small">${html(app.station.address)}</div><div class="divider"></div>
      <div class="sumrow"><span>Колонка</span><strong>${pumpName(app.pump)}</strong></div>
      <div class="sumrow"><span>Топливо</span><strong>${html(app.station.fuels.find(f => f.code === app.fuel)?.name)}</strong></div>
      <div class="sumrow"><span>Объём</span><strong>${litres(app.liters)}</strong></div>
      <div class="sumrow"><span>Цена за литр</span><strong>${money(price())}</strong></div><div class="divider"></div>
      <div class="sumrow"><span>Зарезервируем</span><strong style="font-size:22px">${money(amount())}</strong></div><div class="sumrow"><span>Доступно сейчас</span><strong>${money(app.trip.limitLeft)}</strong></div></div>
      <div class="note orange"><span class="sym">ⓘ</span><div>Сначала резервируется полная сумма. После заправки спишется стоимость фактически залитого топлива, остаток резерва вернётся в лимит.</div></div>
      ${invalid ? `<div class="note red"><span class="sym">!</span><div>По текущей цене этот объём выходит за ограничения. Вернитесь и измените объём.</div></div>` : ''}${alertMarkup()}`,
      button(invalid ? 'Изменить объём' : 'Начать заправку', invalid ? 'back-volume' : 'start', {disabled:app.busy}) + `<div class="foot-label">Одно нажатие — один заказ</div>`, 'back-volume', 'Проверка заказа');
  }
  function progressScreen() {
    const f = app.fueling;
    const waiting = f.status === 'waiting_nozzle';
    const fueling = f.status === 'fueling';
    const fraction = Math.max(0, Math.min(100, 100 * (f.currentLiters || 0) / (f.liters || 1)));
    const elapsed = Math.max(0, Math.floor((Date.now() - f.createdAt - 3000) / 1000));
    const info = waiting ? `<div class="card"><div class="muted small">Ожидание начала налива</div><div class="counter">${elapsed} сек</div><div class="muted small">Вставьте пистолет. Состояние обновится автоматически.</div></div>` : fueling ? `<div class="card"><div class="muted small">Залито на данный момент</div><div class="big" style="margin:7px 0">${litres(f.currentLiters)}</div><div class="fill"><span style="width:${fraction}%"></span></div><p class="small muted">Заказано ${litres(f.liters)}</p></div>` : '';
    const canCancel = f.status === 'accepted' || waiting;
    return shell(`<div class="center"><span class="symbol wait">${fueling ? '⛽' : '…'}</span><h1 class="title">${statusText(f.status)}</h1><p class="muted">${waiting ? 'Вставьте пистолет сразу после разрешения колонки.' : fueling ? 'Не извлекайте пистолет до завершения.' : 'Ожидайте подтверждения от АЗС.'}</p></div>
      <div class="card"><div class="sumrow"><span>АЗС</span><strong>${html(f.stationName)}</strong></div><div class="sumrow"><span>Колонка</span><strong>${pumpName(f.pump)}</strong></div><div class="sumrow"><span>Плановый объём</span><strong>${litres(f.liters)}</strong></div><div class="sumrow"><span>Зарезервировано</span><strong>${money(f.amountHeld)}</strong></div></div>
      ${info}${netMarkup()}${alertMarkup()}`,
      canCancel ? button('Отменить до начала налива', 'cancel', {secondary:true,disabled:app.busy}) + `<div class="foot-label">После начала налива отмена недоступна</div>` : `<div class="foot-label">Статус обновляется автоматически</div>`, '', 'Заказ на АЗС');
  }
  function resultScreen() {
    const f = app.fueling;
    const done = f.status === 'completed';
    return shell(`<div class="center"><span class="symbol ${done ? '' : 'fail'}">${done ? '✓' : '×'}</span><h1 class="title">${done ? 'Заправка завершена' : 'Заказ отменён'}</h1><p class="muted">${done ? 'Стоимость рассчитана по фактически залитому топливу.' : html(cancelReason(f.reason))}</p></div>
      <div class="card"><div class="sumrow"><span>Залито</span><strong>${litres(f.factLiters ?? 0)}</strong></div><div class="sumrow"><span>Списано</span><strong>${money(f.factAmount ?? 0)}</strong></div><div class="sumrow"><span>Возвращено из резерва</span><strong>${money(Math.max(0, f.amountHeld - (f.factAmount || 0)))}</strong></div><div class="divider"></div><div class="sumrow"><span>Доступный лимит</span><strong>${app.confirmedLimit ? money(app.trip.limitLeft) : app.limitLoading ? 'Обновляем…' : 'Не удалось обновить'}</strong></div></div>
      ${!app.confirmedLimit && !app.limitLoading ? `<div class="note red">Остаток лимита пока не подтверждён сервисом.</div>` : ''}
      <div class="note"><span class="sym">ⓘ</span><div>По вопросам получения чека обратитесь к диспетчеру.</div></div>${netMarkup()}${alertMarkup()}`,
      button('На главную', 'finish-home') + (!app.confirmedLimit ? button('Обновить лимит', 'refresh-limit', {secondary:true}) : ''), '', 'Итог операции');
  }

  async function boot() {
    if (app.busy) return;
    app.busy = true;
    app.screen = 'loading';
    clearNotice(); render();
    try {
      const [trip, location] = await Promise.all([api.getTrip(), api.getDriverLocation()]);
      app.trip = trip; app.location = location;
      app.connectionError = false;
      if (app.session.pending) {
        app.screen = 'recovery'; app.busy = false; render();
        await checkPending(); return;
      }
      const active = await api.getActiveFueling();
      if (active) {
        acceptFueling(active); app.busy = false; render(); return;
      }
      if (app.session.fuelingId) {
        try {
          const previous = await api.getFueling(app.session.fuelingId);
          acceptFueling(previous);
          app.busy = false; render(); return;
        } catch (e) {
          if (e.code !== 'NOT_FOUND') throw e;
          app.session.fuelingId = null; saveSaved();
        }
      }
      app.screen = 'home';
    } catch (e) {
      app.screen = app.session.pending ? 'recovery' : 'fatal';
      app.connectionError = e.code === 'NETWORK_ERROR';
      setNotice(e.message || 'Не удалось получить данные рейса.', 'red');
    } finally { app.busy = false; render(); }
  }
  async function openStations() {
    if (app.busy) return;
    app.busy = true; clearNotice();
    try {
      const [trip, stations] = await Promise.all([api.getTrip(), api.getStations()]);
      app.trip = trip;
      app.stations = stations.map(s => ({...s, km: distance(app.location, s)}));
      app.sorting = 'distance'; app.search = ''; app.visibleCount = 12;
      app.connectionError = false; app.screen = 'stations';
    } catch (e) {
      setNotice('Не удалось получить список АЗС. Повторите попытку.', 'red');
      app.connectionError = true;
    } finally { app.busy = false; render(); }
  }
  async function chooseStation(id) {
    if (app.busy) return;
    app.busy = true; app.screen = 'station_loading'; clearNotice(); render();
    try {
      const [station, trip] = await Promise.all([api.getStation(id), api.getTrip()]);
      app.station = station; app.trip = trip;
      app.fuel = station.fuels.some(f => f.code === 'diesel') ? 'diesel' : station.fuels[0].code;
      app.pump = null; app.liters = Math.max(station.litersMin, Math.min(100, station.litersMax));
      app.connectionError = false; app.screen = 'station';
    } catch (e) {
      app.screen = 'stations'; app.connectionError = true;
      setNotice('Не удалось получить подробности АЗС. Выберите её ещё раз.', 'red');
    } finally { app.busy = false; render(); }
  }
  function acceptFueling(f) {
    app.session.pending = null;
    app.session.fuelingId = f.id;
    saveSaved();
    app.fueling = f;
    app.connectionError = false;
    app.screen = f.status === 'completed' || f.status === 'cancelled' ? 'result' : 'progress';
    if (app.screen === 'result') { app.confirmedLimit = false; app.limitLoading = true; }
    clearNotice();
    if (app.screen === 'result') void refreshLimit();
  }
  async function startOrder() {
    if (app.busy || app.session.pending || !validLiters() || app.pump == null) return;
    const request = {
      stationId: app.station.id, pump: app.pump, fuel: app.fuel, liters: app.liters,
      price: price(), clientRequestId: 'ct-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    };
    // Сначала записываем запрос на диск: после обновления вкладки его нельзя потерять.
    app.session.pending = request; app.pendingChecked = false; saveSaved();
    app.busy = true; app.screen = 'sending'; render();
    try {
      if (!navigator.onLine) throw Object.assign(new Error('Нет подключения'), {code:'NETWORK_ERROR'});
      const f = await api.startFueling(request);
      acceptFueling(f);
    } catch (e) {
      if (e.code === 'NETWORK_ERROR') {
        app.connectionError = true; app.screen = 'recovery';
        setNotice('Ответ не получен. Проверяем, был ли создан заказ. Не оформляйте его повторно.', 'red');
      } else {
        app.session.pending = null; saveSaved();
        await handleStartError(e);
      }
    } finally { app.busy = false; render(); if (app.screen === 'recovery') void checkPending(); }
  }
  async function handleStartError(e) {
    if (e.code === 'PRICE_CHANGED') {
      const f = app.station?.fuels.find(f => f.code === app.fuel);
      if (f && Number.isFinite(Number(e.details?.newPrice))) f.price = Number(e.details.newPrice);
      app.screen = 'confirm';
      setNotice(`Цена изменилась. Новая цена — ${money(price())}/л. Проверьте сумму и подтвердите заказ заново.`, 'red');
    } else if (e.code === 'LIMIT_EXCEEDED') {
      app.screen = 'volume';
      if (app.trip && Number.isFinite(Number(e.details?.available))) app.trip.limitLeft = Number(e.details.available);
      setNotice('Доступный лимит изменился. Укажите меньший объём или обратитесь к диспетчеру.', 'red');
    } else if (e.code === 'PUMP_BUSY' || e.code === 'FUEL_NOT_AVAILABLE') {
      app.screen = 'station'; app.pump = null;
      try { app.station = await api.getStation(app.station.id); } catch (_) { /* оставляем последние доступные данные */ }
      setNotice(e.code === 'PUMP_BUSY' ? 'Не удалось начать заправку на этой колонке. Выберите свободную колонку или повторите попытку позже.' : 'На выбранной колонке нет этого топлива. Выберите другую колонку.', 'red');
    } else if (e.code === 'INVALID_LITERS') {
      app.screen = 'volume';
      setNotice('АЗС отклонила объём. Проверьте допустимый диапазон.', 'red');
    } else {
      app.screen = 'confirm'; setNotice(e.message || 'Заказ отклонён. Проверьте данные.', 'red');
    }
  }
  // Фоновая проверка использует только читающий метод и не создаёт заказ.
  async function checkPending() {
    if (app.busy || !app.session.pending || app.screen !== 'recovery') return;
    app.busy = true; lastRecover = Date.now(); render();
    try {
      if (!navigator.onLine) throw Object.assign(new Error('Нет подключения'), {code:'NETWORK_ERROR'});
      const active = await api.getActiveFueling();
      const p = app.session.pending;
      if (active) {
        if (active.stationId === p.stationId && active.pump === Number(p.pump) && active.fuel === p.fuel && Number(active.liters) === Number(p.liters)) {
          acceptFueling(active); return;
        }
        app.pendingChecked = false;
        setNotice('Обнаружена другая незавершённая заправка. Не отправляйте новый заказ до выяснения её состояния.', 'red');
      } else {
        app.pendingChecked = true;
        app.connectionError = false;
        clearNotice();
      }
    } catch (e) {
      app.pendingChecked = false;
      app.connectionError = e.code === 'NETWORK_ERROR';
      setNotice('Не удалось проверить заказ. Повторим проверку при восстановлении связи.', 'red');
    } finally { app.busy = false; render(); }
  }
  // Повтор с тем же clientRequestId только по явному действию водителя.
  async function recover() {
    if (app.busy || !app.session.pending || !app.pendingChecked) return;
    app.busy = true; app.pendingChecked = false; lastRecover = Date.now(); app.screen = 'recovery'; render();
    try {
      if (!navigator.onLine) throw Object.assign(new Error('Нет подключения'), {code:'NETWORK_ERROR'});
      const f = await api.startFueling(app.session.pending);
      acceptFueling(f);
    } catch (e) {
      if (e.code === 'NETWORK_ERROR') {
        app.connectionError = true;
        setNotice('Нет ответа от сервиса. Продолжим проверку при восстановлении связи.', 'red');
      } else {
        const request = app.session.pending;
        app.session.pending = null; saveSaved();
        if (!app.station && app.trip && request) {
          try {
            app.station = await api.getStation(request.stationId);
            app.fuel = request.fuel; app.pump = request.pump; app.liters = request.liters;
          } catch (_) { /* пользователь может повторить выбор АЗС */ }
        }
        if (app.station) await handleStartError(e);
        else { app.screen = 'home'; setNotice('Заказ не принят: ' + (e.message || e.code), 'red'); }
      }
    } finally { app.busy = false; render(); if (app.screen === 'recovery') void checkPending(); }
  }
  async function refreshLimit() {
    try {
      app.trip = await api.getTrip();
      app.confirmedLimit = true; app.connectionError = false;
    } catch (e) {
      app.confirmedLimit = false; app.connectionError = e.code === 'NETWORK_ERROR';
    } finally { app.limitLoading = false; }
    render();
  }
  async function pollFueling() {
    if (polling || app.busy || app.screen !== 'progress' || !app.fueling) return;
    polling = true;
    try {
      if (!navigator.onLine) throw Object.assign(new Error('Нет подключения'), {code:'NETWORK_ERROR'});
      const f = await api.getFueling(app.fueling.id);
      if (app.screen === 'progress' && app.fueling?.id === f.id) acceptFueling(f);
    } catch (e) {
      app.connectionError = e.code === 'NETWORK_ERROR';
      setNotice('Не удалось обновить состояние заправки. Повторять заказ не нужно.', 'red');
    } finally { polling = false; if (app.screen === 'progress') render(); }
  }
  async function cancelOrder() {
    if (app.busy || !app.fueling || !['accepted', 'waiting_nozzle'].includes(app.fueling.status)) return;
    app.busy = true; clearNotice(); render();
    try {
      const f = await api.cancelFueling(app.fueling.id);
      acceptFueling(f);
    } catch (e) {
      if (e.code === 'CANNOT_CANCEL') {
        setNotice('Налив уже начался либо операция завершена. Отмена недоступна.', 'red');
      } else {
        setNotice('Нет подтверждения отмены. Проверяем текущий статус.', 'red');
        app.connectionError = e.code === 'NETWORK_ERROR';
      }
      try {
        const current = await api.getFueling(app.fueling.id);
        acceptFueling(current);
        if (e.code === 'CANNOT_CANCEL') setNotice('Отмена недоступна: операция уже перешла к наливу или завершилась.', 'red');
      } catch (_) { /* оставляем прежний статус, проверку продолжит polling */ }
    } finally { app.busy = false; render(); }
  }
  async function finishHome() {
    if (app.busy) return;
    app.busy = true;
    await refreshLimit();
    if (!app.confirmedLimit) {
      app.busy = false;
      setNotice('Сначала нужно обновить доступный лимит. Проверьте связь.', 'red');
      render(); return;
    }
    app.session.fuelingId = null; app.session.pending = null; saveSaved();
    app.fueling = null; app.station = null;
    app.screen = 'home'; clearNotice(); app.busy = false; render();
  }
  function back(where) {
    if (app.busy || app.session.pending || app.screen === 'progress') return;
    clearNotice(); app.connectionError = false; app.screen = where; render();
  }
  function run(action, target) {
    if (app.busy) return;
    if (action === 'boot') return void boot();
    if (action === 'open-stations') return void openStations();
    if (action === 'toggle-limit-help') { app.showLimitHelp = !app.showLimitHelp; render(); return; }
    if (action === 'choose-station') return void chooseStation(target.dataset.id);
    if (action === 'back-home') return back('home');
    if (action === 'back-stations') return back('stations');
    if (action === 'back-station') return back('station');
    if (action === 'back-volume') return back('volume');
    if (action === 'sort-price' || action === 'sort-distance') { app.sorting = action.slice(5); app.visibleCount = 12; render(); return; }
    if (action === 'show-more') { app.visibleCount += 20; render(); return; }
    if (action === 'choose-fuel') { app.fuel = target.dataset.fuel; app.pump = null; clearNotice(); render(); return; }
    if (action === 'choose-pump') { app.pump = Number(target.dataset.pump); clearNotice(); render(); return; }
    if (action === 'open-volume') {
      if (app.pump == null) return;
      const max = maxLiters();
      app.liters = max >= app.station.litersMin ? Math.min(Math.max(app.liters, app.station.litersMin), max) : app.station.litersMin;
      app.screen = 'volume'; clearNotice(); render(); return;
    }
    if (action === 'less' || action === 'more') { app.liters = round2(Math.max(0, app.liters + (action === 'less' ? -10 : 10))); render(); return; }
    if (action === 'max-liters') { app.liters = maxLiters(); render(); return; }
    if (action === 'open-confirm') { if (!validLiters()) return; app.screen = 'confirm'; clearNotice(); render(); return; }
    if (action === 'start') return void startOrder();
    if (action === 'recover') return void recover();
    if (action === 'check-pending') return void checkPending();
    if (action === 'cancel') return void cancelOrder();
    if (action === 'refresh-limit') return void refreshLimit();
    if (action === 'finish-home') return void finishHome();
  }
  root.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target || target.disabled) return;
    run(target.dataset.action, target);
  });
  root.addEventListener('input', e => {
    if (e.target.id !== 'station-search') return;
    app.search = e.target.value;
    app.visibleCount = 12;
    const list = document.getElementById('station-items');
    if (list) list.innerHTML = stationsItems(); // Не пересоздаём поле ввода при поиске.
  });
  root.addEventListener('change', e => {
    if (e.target.id !== 'liters') return;
    const text = e.target.value.trim();
    app.liters = text === '' ? NaN : Number(text.replace(',', '.'));
    render();
  });
  window.addEventListener('offline', () => {
    app.connectionError = true;
    if (app.screen === 'progress' || app.screen === 'recovery') render();
  });
  window.addEventListener('online', () => {
    if (app.screen === 'recovery') void checkPending();
    else if (app.screen === 'progress') void pollFueling();
    else if (app.screen === 'result' && !app.confirmedLimit) void refreshLimit();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && app.screen === 'progress') void pollFueling();
    if (!document.hidden && app.screen === 'recovery') void checkPending();
  });
  setInterval(() => {
    if (app.screen === 'progress') void pollFueling();
    if (app.screen === 'recovery' && !app.pendingChecked && Date.now() - lastRecover >= 6000) void checkPending();
  }, 2000);
  if (!api) {
    app.screen = 'fatal'; setNotice('Файл fake-api.js не подключён.', 'red'); render();
  } else void boot();
})();
