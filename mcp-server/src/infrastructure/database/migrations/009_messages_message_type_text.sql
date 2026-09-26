-- WhatsApp/Baileys content keys can exceed the original 20-character bound.
-- Keep the provider value intact; message_type is descriptive, not an enum.
ALTER TABLE public.messages
  ALTER COLUMN message_type TYPE text;
