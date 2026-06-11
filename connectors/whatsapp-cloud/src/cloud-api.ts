import pino from 'pino';
import { normalizeWhatsAppPhone } from './phone';

export interface WhatsAppCloudConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  graphApiVersion: string;
}

export interface SendTextInput {
  conversationId?: string;
  to?: string;
  content: string;
  previewUrl?: boolean;
}

export interface SendTemplateInput {
  conversationId?: string;
  to?: string;
  templateName: string;
  languageCode?: string;
  components?: unknown[];
}

export class WhatsAppCloudAPI {
  private logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

  constructor(private config: WhatsAppCloudConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.accessToken && this.config.phoneNumberId);
  }

  redactedConfig(): Record<string, unknown> {
    return {
      phoneNumberId: this.config.phoneNumberId || null,
      businessAccountId: this.config.businessAccountId || null,
      graphApiVersion: this.config.graphApiVersion,
      hasAccessToken: Boolean(this.config.accessToken),
    };
  }

  async sendText(input: SendTextInput): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) {
      throw cloudError('WhatsApp Cloud API is not configured', 'disconnected', 503);
    }

    const normalized = normalizeWhatsAppPhone(input.to || input.conversationId);
    if (!normalized) {
      throw cloudError('Invalid WhatsApp phone number', 'invalid_recipient', 422);
    }
    if (!input.content || !String(input.content).trim()) {
      throw cloudError('Message content is empty', 'invalid_request', 400);
    }

    return this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized.phone,
      type: 'text',
      text: {
        preview_url: Boolean(input.previewUrl),
        body: input.content,
      },
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) {
      throw cloudError('WhatsApp Cloud API is not configured', 'disconnected', 503);
    }

    const normalized = normalizeWhatsAppPhone(input.to || input.conversationId);
    if (!normalized) {
      throw cloudError('Invalid WhatsApp phone number', 'invalid_recipient', 422);
    }
    if (!input.templateName || !String(input.templateName).trim()) {
      throw cloudError('Missing templateName', 'invalid_request', 400);
    }

    return this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized.phone,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode || 'es' },
        ...(Array.isArray(input.components) ? { components: input.components } : {}),
      },
    });
  }

  private async postMessage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = (await safeJson(response)) as Record<string, unknown>;
    if (!response.ok) {
      const metaError = body.error as Record<string, unknown> | undefined;
      const message = String(metaError?.message || response.statusText || 'Meta Graph API error');
      const failureClass = classifyMetaError(response.status, metaError);
      this.logger.warn(
        {
          status: response.status,
          failureClass,
          metaCode: metaError?.code,
          metaSubcode: metaError?.error_subcode,
        },
        'WhatsApp Cloud API send failed'
      );
      throw cloudError(message, failureClass, response.status, body);
    }

    return body;
  }
}

export type CloudFailureClass =
  | 'invalid_request'
  | 'invalid_recipient'
  | 'auth'
  | 'rate_limited'
  | 'template_required'
  | 'disconnected'
  | 'meta_error';

export interface CloudConnectorError extends Error {
  failureClass: CloudFailureClass;
  statusCode: number;
  details?: unknown;
}

export function cloudError(
  message: string,
  failureClass: CloudFailureClass,
  statusCode: number,
  details?: unknown
): CloudConnectorError {
  const error = new Error(message) as CloudConnectorError;
  error.failureClass = failureClass;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function classifyMetaError(
  status: number,
  metaError?: Record<string, unknown>
): CloudFailureClass {
  const code = Number(metaError?.code || 0);
  if (status === 401 || status === 403 || code === 190) return 'auth';
  if (status === 429 || code === 4 || code === 17 || code === 80007) return 'rate_limited';
  if (code === 131047 || code === 131026) return 'template_required';
  if (code === 131030 || code === 131045) return 'invalid_recipient';
  if (status === 400) return 'invalid_request';
  return 'meta_error';
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
