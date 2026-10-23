'use strict';

// Первичная проверка подключения. Сценарий заправки будет реализован отдельно.
(async function init() {
  const status = document.getElementById('status');
  try {
    const trip = await window.FakeApi.getTrip();
    status.textContent = `API подключён: рейс ${trip.from} → ${trip.to}, доступно ${trip.limitLeft.toLocaleString('ru-RU')} ₽.`;
  } catch (error) {
    status.textContent = 'Не удалось загрузить рейс. Обновите страницу, когда связь восстановится.';
    console.warn('Ошибка получения рейса:', error);
  }
})();
