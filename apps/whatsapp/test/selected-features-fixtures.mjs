// Synthetic, account-scoped data for the selected-features browser contract.
export const accounts = [
  { id: 'alpha', label: 'Cuenta Alpha' },
  { id: 'beta', label: 'Cuenta Beta' },
];

export const chats = {
  alpha: [
    {
      id: 'alpha-direct',
      account: 'alpha',
      name: 'Ana Fixture',
      phone: '+34100000001',
      preview: 'Mensaje directo fixture',
      unread: 1,
      presence: 'online',
      avatarUrl: '/api/contacts/alpha-direct/avatar?account=alpha',
      isGroup: false,
      archived: false,
      favorite: false,
      pinned: false,
      muted: false,
    },
    {
      id: 'alpha-group',
      account: 'alpha',
      name: 'Equipo Fixture',
      preview: 'Grupo fixture',
      unread: 0,
      presence: 'unknown',
      isGroup: true,
      archived: false,
      favorite: false,
      pinned: false,
      muted: false,
    },
    {
      id: 'alpha-archived',
      account: 'alpha',
      name: 'Archivado Fixture',
      preview: 'No debe aparecer en Todos',
      unread: 0,
      presence: 'unknown',
      isGroup: false,
      archived: true,
      favorite: false,
      pinned: false,
      muted: false,
    },
  ],
  beta: [
    {
      id: 'beta-direct',
      account: 'beta',
      name: 'Bruno Fixture',
      phone: '+34200000002',
      preview: 'Cuenta beta aislada',
      unread: 0,
      presence: 'unknown',
      isGroup: false,
      archived: false,
      favorite: false,
      pinned: false,
      muted: false,
    },
  ],
};

export const messages = {
  'alpha-direct': [
    {
      id: 'alpha-direct-incoming',
      account: 'alpha',
      chat: 'alpha-direct',
      senderName: 'Ana Fixture',
      senderId: 'ana-fixture',
      text: 'Mensaje visible para marcar leído.',
      timestamp: '2026-09-23T08:00:00.000Z',
      fromMe: false,
      status: 'delivered',
    },
    {
      id: 'alpha-direct-outgoing',
      account: 'alpha',
      chat: 'alpha-direct',
      text: 'Respuesta editable fixture',
      timestamp: '2026-09-23T08:01:00.000Z',
      fromMe: true,
      status: 'read',
    },
  ],
  'alpha-group': [
    {
      id: 'alpha-group-message',
      account: 'alpha',
      chat: 'alpha-group',
      senderName: 'Ana Fixture',
      senderId: 'ana-fixture',
      text: 'Mensaje del grupo fixture',
      timestamp: '2026-09-23T08:02:00.000Z',
      fromMe: false,
      status: 'delivered',
    },
    {
      id: 'alpha-group-poll',
      waMessageId: 'poll-fixture',
      account: 'alpha',
      chat: 'alpha-group',
      senderName: 'Ana Fixture',
      text: '¿A qué hora?',
      type: 'POLL',
      metadata: { kind: 'poll', options: ['20.30h', '21.30h'], selectableCount: 1,
        results: { available: true, availability: 'local_partial', totalVoters: 2, options: [
          { name: '20.30h', count: 2, selectedByMe: false }, { name: '21.30h', count: 0, selectedByMe: false },
        ] } },
      timestamp: '2026-09-23T08:03:00.000Z',
      fromMe: false,
    },
  ],
  'alpha-archived': [
    {
      id: 'alpha-archived-message',
      account: 'alpha',
      chat: 'alpha-archived',
      senderName: 'Archivado Fixture',
      text: 'Historial archivado fixture',
      timestamp: '2026-09-22T08:00:00.000Z',
      fromMe: false,
      status: 'delivered',
    },
  ],
  'beta-direct': [
    {
      id: 'beta-message',
      account: 'beta',
      chat: 'beta-direct',
      senderName: 'Bruno Fixture',
      text: 'Solo cuenta beta',
      timestamp: '2026-09-23T08:03:00.000Z',
      fromMe: false,
      status: 'delivered',
    },
  ],
};

export const contactInfo = {
  'alpha-direct': {
    kind: 'contact',
    id: 'alpha-direct',
    name: 'Ana Fixture',
    phone: '+34100000001',
    about: 'Contacto de prueba',
    presence: 'online',
    avatarUrl: '/fixtures/selected-features-avatar.svg',
    mediaCount: 2,
  },
  'beta-direct': {
    kind: 'contact',
    id: 'beta-direct',
    name: 'Bruno Fixture',
    phone: '+34200000002',
    about: 'Cuenta beta aislada',
    presence: 'unknown',
    mediaCount: 0,
  },
};

export const groupInfo = {
  'alpha-group': {
    kind: 'group',
    id: 'alpha-group',
    name: 'Equipo Fixture',
    description: 'Grupo sintético',
    participants: [
      { id: 'ana-fixture', name: 'Ana Fixture', admin: true },
      { id: 'bruno-fixture', name: 'Bruno Fixture', admin: false },
    ],
  },
};

export const gallery = {
  'alpha-direct': [
    { id: 'photo-one', name: 'Foto fixture 1', url: '/api/media/selected-features-gallery.svg?account=alpha', mimeType: 'image/svg+xml' },
    { id: 'photo-two', name: 'Foto fixture 2', url: '/api/media/selected-features-gallery.svg?account=alpha', mimeType: 'image/svg+xml' },
  ],
  'alpha-group': [],
};

export const aiSessions = [
  { id: 'alpha-session', account: 'alpha', chat: 'alpha-direct', title: 'Consulta Alpha' },
  { id: 'beta-session', account: 'beta', chat: 'beta-direct', title: 'Consulta Beta' },
];

export const newChatResults = {
  alpha: [{ id: 'alpha-direct', name: 'Ana Fixture', phone: '+34100000001' }],
  beta: [{ id: 'beta-direct', name: 'Bruno Fixture', phone: '+34200000002' }],
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
