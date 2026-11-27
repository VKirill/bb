// VK EXPERIMENTAL: the one list of our VK core functions, shown in Settings -> «Функции VK».
// "switch": a user-facing behaviour with a real gate behind an experiment key (default on).
// "always": a plugin API surface our plugins depend on; there is no off position.
// "env": switched by a server/daemon environment variable; the list shows the default state only.

export const vkSwitchKeys = [
  "vkChildToldParent",
  "vkDeliveredLabel",
  "vkFavoriteModels",
  "vkMentionRecency",
  "vkQuietChild",
  "vkThreadInstructions",
] as const;
export type VkSwitchKey = (typeof vkSwitchKeys)[number];

interface VkFeatureBase {
  label: string;
  description: string;
}

export type VkFeature =
  | (VkFeatureBase & { key: VkSwitchKey; kind: "switch" })
  | (VkFeatureBase & { key: string; kind: "always" })
  | (VkFeatureBase & {
      key: string;
      kind: "env";
      envVar: string;
      defaultOn: boolean;
    });

export const vkFeatures: readonly VkFeature[] = [
  {
    key: "vkFavoriteModels",
    kind: "switch",
    label: "Избранные модели",
    description:
      "В выборе модели у каждой строки есть звёздочка; отмеченные модели собираются в блок «Избранные модели» над общим списком.",
  },
  {
    key: "vkMentionRecency",
    kind: "switch",
    label: "Свежие треды в упоминаниях",
    description:
      "Список @-упоминаний тредов сортируется по последней активности, поэтому свежие треды из поздних проектов не пропадают из первых 200.",
  },
  {
    key: "vkQuietChild",
    kind: "switch",
    label: "Тихие дочерние треды",
    description:
      "Помощники, которых плагин (Lane Pilot) пометил тихими, не будят родительского агента сообщением о завершении. Сообщения «нужно внимание» приходят как раньше.",
  },
  {
    key: "vkChildToldParent",
    kind: "switch",
    label: "Без второго уведомления о результате",
    description:
      "Если дочерний тред сам прислал родителю результат (bb thread tell), системное «завершён» поверх него не приходит, и родитель не просыпается дважды.",
  },
  {
    key: "vkDeliveredLabel",
    kind: "switch",
    label: "Название отложенного результата",
    description:
      "Результат долгого инструмента плагина приходит в чат с названием, которое задал плагин («Владелец ответил»), а не с общим «Delivered … result».",
  },
  {
    key: "vkThreadInstructions",
    kind: "switch",
    label: "Системная инструкция треда",
    description:
      "Ядро сохраняет точный текст системной инструкции, который BB отправил агенту при старте треда; плагин Thread Instructions показывает его во вкладке «Инфо» для отладки.",
  },
  {
    key: "ownerAuth",
    kind: "env",
    envVar: "BB_VK_OWNER_AUTH",
    defaultOn: false,
    label: "Вход владельца",
    description:
      "Отличает владельца от агента того же пользователя ОС: подтверждает его ключом, спаренным с хабом, и закрывает опасные действия для агентов.",
  },
  {
    key: "worktreeDeps",
    kind: "env",
    envVar: "BB_VK_WORKTREE_DEPS",
    defaultOn: true,
    label: "Зависимости в worktree",
    description:
      "Новое окружение git worktree получает node_modules основной копии ссылками, и агент не ставит пакеты заново в каждом чате (отключается значением 0).",
  },
  {
    key: "threadStartRetry",
    kind: "env",
    envVar: "BB_VK_THREAD_START_RETRY",
    defaultOn: true,
    label: "Повтор старта треда",
    description:
      "Если агент не ответил на создание сессии за таймаут, демон машины запускает тред заново на свежем агенте (по умолчанию 1 повтор, 0 выключает).",
  },
  {
    key: "sessionPolicy",
    kind: "always",
    label: "Политика сессии",
    description:
      "Плагин решает, какие плагины BB, навыки, MCP-серверы и инструкции грузятся в конкретную сессию агента. Нужна project-folders (вкладка «Контекст сессии»).",
  },
  {
    key: "requiredSessionPolicy",
    kind: "always",
    label: "Обязательная политика и собранный профиль",
    description:
      "Обязательные правила сессии применяются при создании треда, а профиль главного агента собирается заранее. Нужна Lane Pilot и My Posts.",
  },
  {
    key: "requiredSessionPolicyInspection",
    kind: "always",
    label: "Просмотр обязательной политики",
    description:
      "Плагин может проверить, какая обязательная политика сейчас действует и откуда она взялась. Нужна Lane Pilot.",
  },
  {
    key: "excludedPlugins",
    kind: "always",
    label: "Исключение плагина из места",
    description:
      "Плагин, исключённый политикой из проекта или раздела, пропадает и из интерфейса, и из хуков композера. Нужна project-folders.",
  },
  {
    key: "composerDispatch",
    kind: "always",
    label: "Отправка из композера",
    description:
      "Плагин может принять или перехватить отправку сообщения из композера и указать, в каком месте он работает. Нужна Lane Pilot.",
  },
  {
    key: "threadKeys",
    kind: "always",
    label: "Ключи тредов",
    description:
      "Плагин запускает и находит треды по собственному ключу или по метаданным, не создавая дублей. Нужна Lane Pilot.",
  },
  {
    key: "lifecycleDrain",
    kind: "always",
    label: "Жизненный цикл и drain плагина",
    description:
      "При перезагрузке и остановке плагин успевает закончить текущую работу, а ядро ждёт его перед выключением. Нужна Lane Pilot.",
  },
  {
    key: "schedules",
    kind: "always",
    label: "Изолированные расписания",
    description:
      "Плагин создаёт собственные расписания фоновых задач, которые не мешают друг другу и расписаниям BB. Нужна Lane Pilot.",
  },
  {
    key: "hookPolicy",
    kind: "always",
    label: "Лимиты и таймауты хуков",
    description:
      "Плагин задаёт лимиты и видимые таймауты своих хуков, чтобы медленный хук не подвешивал чат. Нужна Lane Pilot.",
  },
  {
    key: "rpcCaller",
    kind: "always",
    label: "Кто вызывает RPC",
    description:
      "Плагин узнаёт, кто вызвал его метод: владелец, другой плагин или агент в треде, и решает, что разрешить. Нужна Lane Pilot.",
  },
  {
    key: "imageEditor",
    kind: "always",
    label: "Редактор картинок",
    description:
      "Плагин подключает свой редактор к вложенным картинкам и прикрепляет результат к сообщению. Нужна Office Viewer.",
  },
  {
    key: "threadInfoSection",
    kind: "always",
    label: "Раздел плагина во вкладке «Инфо»",
    description:
      "Плагин добавляет собственный раздел в карточку «Инфо» треда. Нужна Lane Pilot.",
  },
  {
    key: "directoryMove",
    kind: "always",
    label: "Перенос папки треда",
    description:
      "Плагин-владелец готовит, подтверждает или откатывает перенос рабочей папки треда, чтобы его данные не потерялись. Нужна Lane Pilot.",
  },
  {
    key: "toolCtxMetadata",
    kind: "always",
    label: "Метаданные плагина в инструменте",
    description:
      "Инструмент плагина получает его метаданные текущего треда сразу в контексте вызова, без лишнего запроса. Нужна Lane Pilot.",
  },
  {
    key: "idlePayload",
    kind: "always",
    label: "Последний ход в событии простоя",
    description:
      "Событие «тред освободился» несёт последний завершённый ход и признак субагента, и плагину не нужно перечитывать журнал. Нужна Lane Pilot.",
  },
  {
    key: "launchTuning",
    kind: "always",
    label: "Тонкая настройка запуска агента",
    description:
      "Плагин сужает запуск помощника: режим «ask» или «plan» для ACP-агентов, запрет инструментов для Claude Code. Включается только метаданными плагина.",
  },
  {
    key: "systemNotice",
    kind: "always",
    label: "Уведомление плагина как системное",
    description:
      "Плагин отправляет в тред свою заметку как системное сообщение BB, а не как слова владельца. Нужна Lane Pilot.",
  },
  {
    key: "detachToolCall",
    kind: "always",
    label: "Отложенный результат инструмента",
    description:
      "Инструмент плагина отвечает модели сразу, а итог долгой работы приходит в чат системным сообщением. Нужна Lane Pilot.",
  },
  {
    key: "claudeBridgeToolPresentation",
    kind: "always",
    label: "Названия инструментов плагинов в Claude Code",
    description:
      "Вызовы инструментов плагинов в Claude Code показываются с названием и значком, которые задал плагин. Нужна Lane Pilot.",
  },
  {
    key: "cursorBridgeMcp",
    kind: "always",
    label: "Инструменты плагинов в Cursor",
    description:
      "Перед запуском Cursor ядро подключает мост bb-bridge, и агент видит инструменты всех плагинов (Image Studio, Env Catalog, File Gateway).",
  },
  {
    key: "modelPickerUnity",
    kind: "always",
    label: "Единый вид выбора модели",
    description:
      "Списки моделей у всех провайдеров выглядят одинаково, а уровни рассуждения идут от слабого к сильному.",
  },
  {
    key: "serverSettings",
    kind: "always",
    label: "Настройки сервера BB",
    description:
      "Управляемые ключи BB_INFERENCE_SERVICE_TIER (быстрый тариф Codex для заголовков) и BB_THREAD_TITLE_LANGUAGE (язык заголовков тредов).",
  },
  {
    key: "skillTreeCache",
    kind: "always",
    label: "Кэш деревьев навыков",
    description:
      "Демон машины держит в кэше весь каталог навыков, поэтому тред стартует быстрее и без сотен повторных запросов к серверу.",
  },
];
