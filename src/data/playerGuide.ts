/**
 * Player Guide - How to Play Quest Keeper AI
 * 
 * Shown as the first message for new players (first 100 chat sessions).
 */

export const PLAYER_GUIDE = `# 🎮 Добро пожаловать в Quest Keeper AI!

Ты начинаешь приключение с личным AI **Мастером подземелий**.

---

## 🎭 Как это работает

| Ты | Мастер AI |
|-------------|-------------|
| Описываешь действия персонажа | Описывает мир и историю |
| Принимаешь решения | Управляет NPC и врагами |
| Задаешь вопросы | Бросает кости и применяет правила |
| Играешь | Создает испытания и награды |

---

## ⌨️ Быстрое управление

| Действие | Как |
|--------|-----|
| Отправить сообщение | **Enter** |
| Новый чат | Кнопка **+** сбоку |
| Открыть персонажа | Вкладка **Персонаж** |
| Осмотреть карту | 3D-сцена |
| Начать приключение | Команда **/start** |

---

## 💬 Что писать

**Хорошие примеры:**
- "Я обыскиваю комнату в поисках тайных дверей"
- "Я спрашиваю бармена о слухах"
- "Я атакую гоблина мечом"
- "Я пытаюсь прокрасться мимо стражников"

**Мастер сделает остальное:**
- броски костей
- расчет урона
- учет инвентаря
- ходы в бою

---

## ⚔️ Во время боя

1. **Дождись**, пока Мастер объявит твой ход
2. **Опиши** действие: "Я бью орка!"
3. **Мастер** бросит кости и опишет результат
4. **Повторяй**, пока бой не закончится

> 💡 Мастер сам управляет врагами; тебе нужно сосредоточиться на своем персонаже.

---

## 🎯 Советы

- **Держись роли**, если хочешь более живой отыгрыш
- **Задавай вопросы**, если что-то непонятно
- **Пробуй творческие решения**: Мастер любит умные ходы
- **Записывай** имена NPC и важные факты
- **Экспериментируй** с навыками, заклинаниями и предметами

---

## 🚀 Готов?

Чтобы начать приключение, создай персонажа:

> **Введи \`/start\` и нажми Enter**

*Путь ждет. Ты станешь героем... или легендой?*
`;

/**
 * Get the storage key for tracking session count
 */
const SESSION_COUNT_KEY = 'quest-keeper-session-count';
const MAX_TUTORIAL_SESSIONS = 100;

/**
 * Check if the player guide should be shown
 */
export function shouldShowPlayerGuide(): boolean {
  const countStr = localStorage.getItem(SESSION_COUNT_KEY);
  const count = countStr ? parseInt(countStr, 10) : 0;
  return count < MAX_TUTORIAL_SESSIONS;
}

/**
 * Increment the session count (call when starting a new chat)
 */
export function incrementSessionCount(): number {
  const countStr = localStorage.getItem(SESSION_COUNT_KEY);
  const count = (countStr ? parseInt(countStr, 10) : 0) + 1;
  localStorage.setItem(SESSION_COUNT_KEY, count.toString());
  return count;
}

/**
 * Get the current session count
 */
export function getSessionCount(): number {
  const countStr = localStorage.getItem(SESSION_COUNT_KEY);
  return countStr ? parseInt(countStr, 10) : 0;
}

/**
 * Reset the session counter (for testing)
 */
export function resetSessionCount(): void {
  localStorage.removeItem(SESSION_COUNT_KEY);
}
