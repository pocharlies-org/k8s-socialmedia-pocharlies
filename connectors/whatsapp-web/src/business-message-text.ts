import { normalizeMessageContent, type proto } from '@whiskeysockets/baileys';

export const BUSINESS_MESSAGE_TYPES = [
  'TEMPLATEMESSAGE',
  'BUTTONSMESSAGE',
  'TEMPLATEBUTTONREPLYMESSAGE',
  'BUTTONSRESPONSEMESSAGE',
  'LISTMESSAGE',
  'LISTRESPONSEMESSAGE',
  'INTERACTIVEMESSAGE',
  'INTERACTIVERESPONSEMESSAGE',
] as const;

function lines(values: unknown[]): string | null {
  const text = values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(text)].join('\n') || null;
}

/** Native flow JSON also contains routing IDs and secrets: only visible labels qualify. */
function nativeLabels(json: string | null | undefined): string | null {
  if (!json || json.length > 65536) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    return lines([fields.display_text, fields.selected_display_text, fields.title, fields.text]);
  } catch {
    return null;
  }
}

function interactiveText(message: proto.Message.IInteractiveMessage, depth: number): string | null {
  if (depth > 5) return null;
  return lines([
    message.header?.title,
    message.header?.subtitle,
    message.body?.text,
    message.footer?.text,
    ...(message.nativeFlowMessage?.buttons || []).map(button =>
      nativeLabels(button.buttonParamsJson)
    ),
    ...(message.carouselMessage?.cards || []).map(card => interactiveText(card, depth + 1)),
  ]);
}

function templateText(message: proto.Message.ITemplateMessage, depth: number): string | null {
  if (depth > 5) return null;
  const hydrated = message.hydratedTemplate || message.hydratedFourRowTemplate;
  const fourRow = message.fourRowTemplate;
  return lines([
    hydrated?.hydratedTitleText,
    hydrated?.hydratedContentText,
    hydrated?.hydratedFooterText,
    ...(hydrated?.hydratedButtons || []).map(button =>
      lines([
        button.quickReplyButton?.displayText,
        button.urlButton?.displayText,
        button.callButton?.displayText,
      ])
    ),
    // HSM namespace/elementName/params are template identifiers, not rendered text.
    ...[fourRow?.content, fourRow?.footer, fourRow?.highlyStructuredMessage].map(hsm =>
      hsm?.hydratedHsm ? templateText(hsm.hydratedHsm, depth + 1) : null
    ),
    ...(fourRow?.buttons || []).map(button =>
      lines(
        [
          button.quickReplyButton?.displayText,
          button.urlButton?.displayText,
          button.callButton?.displayText,
        ].map(hsm => (hsm?.hydratedHsm ? templateText(hsm.hydratedHsm, depth + 1) : null))
      )
    ),
    message.interactiveMessageTemplate
      ? interactiveText(message.interactiveMessageTemplate, depth + 1)
      : null,
  ]);
}

/** Extract only provider-visible text; never use IDs, URLs or arbitrary JSON as a fallback. */
export function businessMessageText(
  message: proto.IMessage | null | undefined
): { text: string | null; type: string } | null {
  const content = normalizeMessageContent(message);
  if (!content) return null;
  if (content.templateMessage)
    return { type: 'TEMPLATEMESSAGE', text: templateText(content.templateMessage, 0) };
  if (content.buttonsMessage) {
    const buttons = content.buttonsMessage;
    return {
      type: 'BUTTONSMESSAGE',
      text: lines([
        buttons.text,
        buttons.contentText,
        buttons.footerText,
        ...(buttons.buttons || []).map(button =>
          lines([button.buttonText?.displayText, nativeLabels(button.nativeFlowInfo?.paramsJson)])
        ),
      ]),
    };
  }
  if (content.templateButtonReplyMessage)
    return {
      type: 'TEMPLATEBUTTONREPLYMESSAGE',
      text: lines([content.templateButtonReplyMessage.selectedDisplayText]),
    };
  if (content.buttonsResponseMessage)
    return {
      type: 'BUTTONSRESPONSEMESSAGE',
      text: lines([content.buttonsResponseMessage.selectedDisplayText]),
    };
  if (content.listMessage) {
    const list = content.listMessage;
    return {
      type: 'LISTMESSAGE',
      text: lines([
        list.title,
        list.description,
        list.footerText,
        list.buttonText,
        ...(list.sections || []).map(section =>
          lines([
            section.title,
            ...(section.rows || []).map(row => lines([row.title, row.description])),
          ])
        ),
      ]),
    };
  }
  if (content.listResponseMessage)
    return {
      type: 'LISTRESPONSEMESSAGE',
      text: lines([content.listResponseMessage.title, content.listResponseMessage.description]),
    };
  if (content.interactiveMessage)
    return { type: 'INTERACTIVEMESSAGE', text: interactiveText(content.interactiveMessage, 0) };
  if (content.interactiveResponseMessage)
    return {
      type: 'INTERACTIVERESPONSEMESSAGE',
      text: lines([
        content.interactiveResponseMessage.body?.text,
        nativeLabels(content.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson),
      ]),
    };
  return null;
}
