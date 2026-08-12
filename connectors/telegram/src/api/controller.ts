import { Router, Request, Response, NextFunction } from 'express';
import { TelegramClientWrapper } from '../telegram-client';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

/**
 * Authentication middleware
 */
function authMiddleware(
  sharedSecret: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'] as string;
    const timestamp = req.headers['x-connector-timestamp'] as string;

    if (!signature || !timestamp) {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 300) {
      res.status(401).json({ error: 'Request expired' });
      return;
    }

    const expectedSignature = generateHMACSignature(req.body || {}, requestTime, sharedSecret);
    if (signature !== expectedSignature) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  };
}

export function createRouter(client: TelegramClientWrapper, sharedSecret: string): Router {
  const router = Router();

  // Apply auth middleware to all routes
  router.use(authMiddleware(sharedSecret));

  /**
   * GET /status - Get connection status
   */
  router.get('/status', (req: Request, res: Response) => {
    res.json({
      connected: client.isClientConnected(),
      platform: 'telegram',
    });
  });

  /**
   * GET /me - Get account info
   */
  router.get('/me', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const me = await client.getMe();
        res.json(me);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /dialogs - Get all dialogs (chats)
   */
  router.get('/dialogs', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const dialogs = await client.getDialogs();
        res.json({ dialogs });
      } catch (error) {
        logger.error(`Error getting dialogs: ${String(error)}`);
        res.status(500).json({ error: 'Failed to get dialogs' });
      }
    })();
  });

  /**
   * GET /chats/unread - Get chats with unread messages
   * NOTE: Must be registered BEFORE /chats/:id routes
   */
  router.get('/chats/unread', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const chats = await client.getUnreadChats();
        res.json({ chats });
      } catch (e) {
        logger.error(`Error getting unread chats: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /chats/:id/info - Get chat info
   */
  router.get('/chats/:id/info', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const info = await client.getChatInfo(req.params.id);
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /chats/:id/participants - Get chat participants
   */
  router.get('/chats/:id/participants', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const participants = await client.getParticipants(req.params.id, limit);
        res.json({ participants });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /groups - Create a group, supergroup/forum, or channel.
   */
  router.post('/groups', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { title, type, description, forum, members } = req.body;
        if (typeof title !== 'string' || !title.trim()) {
          res.status(400).json({ error: 'Missing title' });
          return;
        }
        if (type !== 'group' && type !== 'supergroup' && type !== 'channel') {
          res.status(400).json({ error: "type must be 'group', 'supergroup' or 'channel'" });
          return;
        }
        if (members !== undefined && !Array.isArray(members)) {
          res.status(400).json({ error: 'members must be an array' });
          return;
        }
        const result = await client.createManagedGroup({
          title,
          type,
          description: typeof description === 'string' ? description : undefined,
          forum: forum === true,
          members,
        });
        res.json(result);
      } catch (e) {
        logger.error(`Error creating Telegram group: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /chats/:id/members - Add members to a group, supergroup, or channel.
   */
  router.post('/chats/:id/members', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { members, forwardCount } = req.body;
        if (!Array.isArray(members) || !members.length) {
          res.status(400).json({ error: 'members must contain at least one peer' });
          return;
        }
        const parsedForwardCount = forwardCount === undefined ? 0 : Number(forwardCount);
        if (
          !Number.isInteger(parsedForwardCount) ||
          parsedForwardCount < 0 ||
          parsedForwardCount > 100
        ) {
          res.status(400).json({ error: 'forwardCount must be an integer from 0 to 100' });
          return;
        }
        const result = await client.addManagedChatMembers(
          req.params.id,
          members,
          parsedForwardCount
        );
        res.json(result);
      } catch (e) {
        logger.error(`Error adding Telegram chat members: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * PUT /chats/:id/admins/:userId - Set or revoke Telegram admin permissions.
   */
  router.put('/chats/:id/admins/:userId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { rights, rank } = req.body;
        if (!rights || typeof rights !== 'object' || Array.isArray(rights)) {
          res.status(400).json({ error: 'rights must be an object of boolean permissions' });
          return;
        }
        const allowedRights = new Set([
          'changeInfo',
          'postMessages',
          'editMessages',
          'deleteMessages',
          'banUsers',
          'inviteUsers',
          'pinMessages',
          'addAdmins',
          'anonymous',
          'manageCall',
          'other',
          'manageTopics',
          'postStories',
          'editStories',
          'deleteStories',
          'manageDirectMessages',
        ]);
        if (
          Object.entries(rights).some(
            ([name, value]) => !allowedRights.has(name) || typeof value !== 'boolean'
          )
        ) {
          res.status(400).json({ error: 'rights contains an unknown or non-boolean permission' });
          return;
        }
        if (rank !== undefined && typeof rank !== 'string') {
          res.status(400).json({ error: 'rank must be a string' });
          return;
        }
        const result = await client.setManagedChatAdmin(
          req.params.id,
          req.params.userId,
          rights,
          rank
        );
        res.json(result);
      } catch (e) {
        logger.error(`Error setting Telegram admin permissions: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /chats/:id/topics - List forum topics for a supergroup
   */
  router.get('/chats/:id/topics', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const limit = parseInt(req.query.limit as string) || 100;
        const query = typeof req.query.query === 'string' ? req.query.query : '';
        const topics = await client.getForumTopics(req.params.id, limit, query);
        res.json({ topics });
      } catch (e) {
        logger.error(`Error getting forum topics: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * Parse a :topicId path param. Topic ids are the top message id, always positive.
   */
  function parseTopicId(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * POST /chats/:id/topics - Create a forum topic
   */
  router.post('/chats/:id/topics', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { title, icon } = req.body;
        if (typeof title !== 'string' || !title.trim()) {
          res.status(400).json({ error: 'Missing title' });
          return;
        }
        const parsedIcon = icon !== undefined && icon !== null ? Number(icon) : undefined;
        if (parsedIcon !== undefined && !Number.isInteger(parsedIcon)) {
          res.status(400).json({ error: 'icon must be an integer' });
          return;
        }

        const topic = await client.createForumTopic(req.params.id, title, parsedIcon);
        res.json(topic);
      } catch (e) {
        logger.error(`Error creating forum topic: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * PATCH /chats/:id/topics/:topicId - Edit a forum topic
   */
  router.patch('/chats/:id/topics/:topicId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const topicId = parseTopicId(req.params.topicId);
        if (topicId === null) {
          res.status(400).json({ error: 'Invalid topicId' });
          return;
        }

        const { title, closed, hidden, clearIcon } = req.body;
        if (
          title === undefined &&
          closed === undefined &&
          hidden === undefined &&
          clearIcon === undefined
        ) {
          res.status(400).json({ error: 'Nothing to update' });
          return;
        }

        const topic = await client.editForumTopic(req.params.id, topicId, {
          title,
          closed,
          hidden,
          clearIcon,
        });
        res.json(topic);
      } catch (e) {
        logger.error(`Error editing forum topic: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /chats/:id/topics/:topicId/closed - Open/close a forum topic
   */
  router.post('/chats/:id/topics/:topicId/closed', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const topicId = parseTopicId(req.params.topicId);
        if (topicId === null) {
          res.status(400).json({ error: 'Invalid topicId' });
          return;
        }
        if (typeof req.body.closed !== 'boolean') {
          res.status(400).json({ error: 'closed must be a boolean' });
          return;
        }

        const topic = await client.toggleForumTopicClosed(req.params.id, topicId, req.body.closed);
        res.json(topic);
      } catch (e) {
        logger.error(`Error toggling forum topic closed: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /chats/:id/topics/:topicId/pinned - Pin/unpin a forum topic
   */
  router.post('/chats/:id/topics/:topicId/pinned', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const topicId = parseTopicId(req.params.topicId);
        if (topicId === null) {
          res.status(400).json({ error: 'Invalid topicId' });
          return;
        }
        if (typeof req.body.pinned !== 'boolean') {
          res.status(400).json({ error: 'pinned must be a boolean' });
          return;
        }

        const topic = await client.toggleForumTopicPinned(req.params.id, topicId, req.body.pinned);
        res.json(topic);
      } catch (e) {
        logger.error(`Error toggling forum topic pinned: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * DELETE /chats/:id/topics/:topicId - Delete a forum topic and all its history
   * NOTE: topicId is in the path because the MCP server sends no body on DELETE.
   */
  router.delete('/chats/:id/topics/:topicId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const topicId = parseTopicId(req.params.topicId);
        if (topicId === null) {
          res.status(400).json({ error: 'Invalid topicId' });
          return;
        }

        const result = await client.deleteForumTopic(req.params.id, topicId);
        res.json(result);
      } catch (e) {
        logger.error(`Error deleting forum topic: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /chats/:id/forum-settings - Toggle forum mode for a supergroup (owner only)
   */
  router.post('/chats/:id/forum-settings', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { isForum, threadsMode } = req.body;
        if (typeof isForum !== 'boolean') {
          res.status(400).json({ error: 'isForum must be a boolean' });
          return;
        }
        if (threadsMode !== undefined && threadsMode !== 'list' && threadsMode !== 'tabs') {
          res.status(400).json({ error: "threadsMode must be 'list' or 'tabs'" });
          return;
        }

        const result = await client.updateForumSettings(req.params.id, isForum, threadsMode);
        res.json(result);
      } catch (e) {
        logger.error(`Error updating forum settings: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * PATCH /chats/:id/title - Change the chat title
   */
  router.patch('/chats/:id/title', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { title } = req.body;
        if (typeof title !== 'string' || !title.trim()) {
          res.status(400).json({ error: 'Missing title' });
          return;
        }

        const result = await client.setChatTitle(req.params.id, title);
        res.json(result);
      } catch (e) {
        logger.error(`Error setting chat title: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * PATCH /chats/:id/description - Change the chat description ('' clears it)
   */
  router.patch('/chats/:id/description', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { description } = req.body;
        if (typeof description !== 'string') {
          res.status(400).json({ error: 'description must be a string' });
          return;
        }

        const result = await client.setChatDescription(req.params.id, description);
        res.json(result);
      } catch (e) {
        logger.error(`Error setting chat description: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * PATCH /chats/:id/photo - Change the chat photo/video
   */
  router.patch('/chats/:id/photo', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { filePath, type } = req.body;
        if (typeof filePath !== 'string' || !filePath.trim()) {
          res.status(400).json({ error: 'Missing filePath' });
          return;
        }
        if (type !== undefined && type !== 'photo' && type !== 'video') {
          res.status(400).json({ error: "type must be 'photo' or 'video'" });
          return;
        }

        const result = await client.setChatPhoto(req.params.id, filePath, type);
        res.json(result);
      } catch (e) {
        logger.error(`Error setting chat photo: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /messages/:chatId - Get messages for a chat
   */
  router.get('/messages/:chatId', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { chatId } = req.params;
        const limit = parseInt(req.query.limit as string) || 100;
        const offsetId = req.query.offsetId ? parseInt(req.query.offsetId as string) : undefined;

        const messages = await client.getMessages(chatId, limit, offsetId);
        res.json({ messages });
      } catch (error) {
        logger.error(`Error getting messages: ${String(error)}`);
        res.status(500).json({ error: 'Failed to get messages' });
      }
    })();
  });

  /**
   * POST /messages/search - Search messages
   * NOTE: Must be registered BEFORE /messages/:chatId POST route
   */
  router.post('/messages/search', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { query, chatId, limit, threadId, offsetId } = req.body;
        if (query === undefined || query === null) {
          res.status(400).json({ error: 'Missing query' });
          return;
        }
        const parsedThreadId =
          threadId !== undefined && threadId !== null ? Number(threadId) : undefined;
        if (
          parsedThreadId !== undefined &&
          (!Number.isInteger(parsedThreadId) || parsedThreadId <= 0)
        ) {
          res.status(400).json({ error: 'threadId must be a positive integer' });
          return;
        }

        const parsedOffsetId =
          offsetId !== undefined && offsetId !== null ? Number(offsetId) : undefined;
        if (
          parsedOffsetId !== undefined &&
          (!Number.isInteger(parsedOffsetId) || parsedOffsetId <= 0)
        ) {
          res.status(400).json({ error: 'offsetId must be a positive integer' });
          return;
        }

        const results = await client.searchMessages(
          String(query),
          chatId,
          limit || 20,
          parsedThreadId,
          parsedOffsetId
        );
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /messages/reactors/:chatId/:msgId - Per-reactor identity for a message.
   * Returns `[{emoji, userId, displayName, mine}]`. Used by the dashboard's
   * "who reacted?" tooltip when the user hovers/clicks a reaction badge.
   */
  router.get('/messages/reactors/:chatId/:msgId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const msgId = parseInt(req.params.msgId, 10);
        const limit = parseInt((req.query.limit as string) || '100', 10);
        if (Number.isNaN(msgId)) {
          res.status(400).json({ error: 'Bad msgId' });
          return;
        }
        const reactors = await client.getReactionUsers(req.params.chatId, msgId, limit);
        res.json({ reactors: reactors || [] });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/react - Add or clear an emoji reaction on a message
   */
  router.post('/messages/react', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, messageId, emoji } = req.body as {
          chatId?: string;
          messageId?: number | string;
          emoji?: string;
        };
        if (!chatId || messageId === undefined || messageId === null) {
          res.status(400).json({ error: 'Missing chatId or messageId' });
          return;
        }
        const msgId = typeof messageId === 'string' ? parseInt(messageId, 10) : messageId;
        const ok = await client.reactToMessage(chatId, msgId, emoji || null);
        res.json({ reacted: ok, emoji: emoji || null });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/callback - Click a Telegram inline callback button.
   */
  router.post('/messages/callback', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }
        const { chatId, messageId, data, timeoutMs, fireAndForget } = req.body as {
          chatId?: string;
          messageId?: number | string;
          data?: string;
          timeoutMs?: number | string;
          fireAndForget?: boolean;
        };
        if (!chatId || messageId === undefined || messageId === null || data === undefined) {
          res.status(400).json({ error: 'Missing chatId, messageId or data' });
          return;
        }
        const msgId = typeof messageId === 'string' ? Number(messageId) : messageId;
        if (!Number.isInteger(msgId) || msgId <= 0) {
          res.status(400).json({ error: 'messageId must be a positive integer' });
          return;
        }
        const timeout =
          timeoutMs !== undefined && timeoutMs !== null && timeoutMs !== ''
            ? Number(timeoutMs)
            : undefined;
        if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
          res.status(400).json({ error: 'timeoutMs must be a positive integer' });
          return;
        }
        const answer = await client.clickCallbackButton(chatId, msgId, String(data), {
          ...(timeout ? { timeoutMs: timeout } : {}),
          fireAndForget: fireAndForget === true,
        });
        res.json({ clicked: true, answer });
      } catch (e) {
        logger.error(`Error clicking callback button: ${String(e)}`);
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/forward - Forward a message
   */
  router.post('/messages/forward', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { fromChatId, messageId, toChatId, threadId } = req.body as {
          fromChatId?: string;
          messageId?: string | number;
          toChatId?: string;
          threadId?: string | number;
        };
        if (!fromChatId || !messageId || !toChatId) {
          res.status(400).json({ error: 'Missing fields' });
          return;
        }
        const toThreadId =
          threadId !== undefined && threadId !== null ? parseTopicId(threadId) : undefined;
        if (threadId !== undefined && threadId !== null && toThreadId === null) {
          res.status(400).json({ error: 'threadId must be a positive integer' });
          return;
        }
        await client.forwardMessage(
          fromChatId,
          Number(messageId),
          toChatId,
          toThreadId ?? undefined
        );
        res.json({ forwarded: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/media/send - Send a file
   */
  router.post('/messages/media/send', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, filePath, caption, voiceNote, videoNote, sticker, replyTo, threadId } =
          req.body as {
            chatId?: string;
            filePath?: string;
            caption?: string;
            voiceNote?: boolean;
            videoNote?: boolean;
            sticker?: boolean;
            replyTo?: string | number;
            threadId?: string | number;
          };
        if (!chatId || !filePath) {
          res.status(400).json({ error: 'Missing chatId or filePath' });
          return;
        }
        const parsedReplyTo =
          replyTo !== undefined && replyTo !== null ? parseTopicId(replyTo) : undefined;
        if (replyTo !== undefined && replyTo !== null && parsedReplyTo === null) {
          res.status(400).json({ error: 'replyTo must be a positive integer' });
          return;
        }
        const parsedThreadId =
          threadId !== undefined && threadId !== null ? parseTopicId(threadId) : undefined;
        if (threadId !== undefined && threadId !== null && parsedThreadId === null) {
          res.status(400).json({ error: 'threadId must be a positive integer' });
          return;
        }
        await client.sendFile(chatId, filePath, {
          caption,
          voiceNote,
          videoNote,
          sticker,
          replyTo: parsedReplyTo ?? undefined,
          threadId: parsedThreadId ?? undefined,
        });
        res.json({ sent: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/media/group - Send 2-10 images as one native Telegram album.
   */
  router.post('/messages/media/group', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, attachments, replyTo, threadId } = req.body as {
          chatId?: string;
          attachments?: Array<{
            filePath?: string;
            name?: string;
            mimeType?: string;
            caption?: string;
          }>;
          replyTo?: string | number;
          threadId?: string | number;
        };
        if (!chatId || !Array.isArray(attachments)) {
          res.status(400).json({ error: 'Missing chatId or attachments' });
          return;
        }
        if (attachments.length < 2 || attachments.length > 10) {
          res.status(400).json({ error: 'attachments must contain between 2 and 10 images' });
          return;
        }
        if (
          attachments.some(
            item =>
              !item ||
              typeof item.filePath !== 'string' ||
              !item.filePath ||
              (item.mimeType !== undefined && !item.mimeType.toLowerCase().startsWith('image/'))
          )
        ) {
          res.status(400).json({ error: 'Every attachment must be an image with a filePath' });
          return;
        }
        const parsedReplyTo =
          replyTo !== undefined && replyTo !== null ? parseTopicId(replyTo) : undefined;
        if (replyTo !== undefined && replyTo !== null && parsedReplyTo === null) {
          res.status(400).json({ error: 'replyTo must be a positive integer' });
          return;
        }
        const parsedThreadId =
          threadId !== undefined && threadId !== null ? parseTopicId(threadId) : undefined;
        if (threadId !== undefined && threadId !== null && parsedThreadId === null) {
          res.status(400).json({ error: 'threadId must be a positive integer' });
          return;
        }
        const messageIds = await client.sendImageGroup(
          chatId,
          attachments.map(item => ({
            filePath: item.filePath as string,
            caption: item.caption,
          })),
          {
            replyTo: parsedReplyTo ?? undefined,
            threadId: parsedThreadId ?? undefined,
          }
        );
        res.json({ sent: true, messageId: messageIds[0] ?? null, messageIds });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/voice - Send a voice note from base64 audio bytes.
   */
  router.post('/messages/voice', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, audioBase64, caption, mimeType, voiceNote } = req.body as {
          chatId?: string;
          audioBase64?: string;
          caption?: string;
          mimeType?: string;
          voiceNote?: boolean;
        };
        if (!chatId || !audioBase64) {
          res.status(400).json({ error: 'Missing chatId or audioBase64' });
          return;
        }
        const audio = Buffer.from(audioBase64, 'base64');
        await client.sendFile(chatId, audio, {
          caption,
          voiceNote: voiceNote !== false,
        });
        res.json({ sent: true, mimeType: mimeType || 'audio/ogg' });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/read/:chatId - Mark chat as read
   */
  router.post('/messages/read/:chatId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        await client.markAsRead(req.params.chatId);
        res.json({ markedAsRead: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /messages/media/:chatId/:msgId - Download media
   */
  router.get('/messages/media/:chatId/:msgId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const buffer = await client.downloadMedia(req.params.chatId, parseInt(req.params.msgId));
        if (!buffer) {
          res.status(404).json({ error: 'No media' });
          return;
        }
        res.json({ data: buffer.toString('base64'), size: buffer.length });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /peers/:id/photo - Download a peer's profile photo (big size).
   * Returns {data: base64, size, contentType: 'image/jpeg'} or 404 if no photo.
   */
  router.get('/peers/:id/photo', (req: Request, res: Response): void => {
    void (async () => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }
        const buffer = await client.downloadPeerPhoto(req.params.id);
        if (!buffer) {
          res.status(404).json({ error: 'No photo' });
          return;
        }
        res.json({
          data: buffer.toString('base64'),
          size: buffer.length,
          contentType: 'image/jpeg',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/voice - Send a voice note from base64 audio bytes.
   *
   * This route must be registered before /messages/:chatId so "voice" is not
   * interpreted as a chat id by Express.
   */
  router.post('/messages/voice', (req: Request, res: Response): void => {
    void (async () => {
      try {
        const { chatId, audioBase64, caption, mimeType, voiceNote } = req.body as {
          chatId?: string;
          audioBase64?: string;
          caption?: string;
          mimeType?: string;
          voiceNote?: boolean;
        };
        if (!chatId || !audioBase64) {
          res.status(400).json({ error: 'Missing chatId or audioBase64' });
          return;
        }

        const audio = Buffer.from(audioBase64, 'base64');
        await client.sendFile(chatId, audio, {
          caption,
          voiceNote: voiceNote !== false,
        });
        res.json({ sent: true, mimeType: mimeType || 'audio/ogg' });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * POST /messages/:chatId - Send a message
   */
  router.post('/messages/:chatId', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        if (!client.isClientConnected()) {
          res.status(503).json({ error: 'Not connected to Telegram' });
          return;
        }

        const { chatId } = req.params;
        const body = req.body as {
          text?: string;
          topicId?: number | string;
          replyTo?: number | string;
        };
        const text = body.text;

        if (!text) {
          res.status(400).json({ error: 'Missing text in request body' });
          return;
        }

        let tid: number | undefined;
        if (body.topicId !== undefined && body.topicId !== null) {
          tid = Number(body.topicId);
          if (!Number.isInteger(tid) || tid <= 0) {
            res.status(400).json({ error: 'topicId must be a positive integer' });
            return;
          }
        }

        let replyTo: number | undefined;
        if (body.replyTo !== undefined && body.replyTo !== null) {
          const n = Number(body.replyTo);
          if (Number.isInteger(n) && n > 0) replyTo = n;
        }

        const messageId = await client.sendMessage(chatId, text, tid, replyTo);
        res.json({ success: true, messageId });
      } catch (error) {
        logger.error(`Error sending message: ${String(error)}`);
        res.status(500).json({ error: 'Failed to send message' });
      }
    })();
  });

  /**
   * DELETE /messages/:chatId/:msgId - Delete a message
   */
  router.delete('/messages/:chatId/:msgId', (req: Request, res: Response): void => {
    void (async () => {
      try {
        await client.deleteMessage(req.params.chatId, parseInt(req.params.msgId));
        res.json({ deleted: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  /**
   * GET /session - Get session string
   */
  router.get('/session', (req: Request, res: Response) => {
    try {
      const sessionString = client.getSessionString();
      res.json({ sessionString });
    } catch (error) {
      logger.error(`Error getting session: ${String(error)}`);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  return router;
}
