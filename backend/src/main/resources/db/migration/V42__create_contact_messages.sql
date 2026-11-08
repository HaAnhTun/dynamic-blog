-- Messages sent through the public contact form. Personal data: a visitor's name, email address and free text. The row is
-- written before any mail is attempted and is the record of the message; the optional mail to the site owner is a copy.
-- read_at is NULL until the admin opens the message; the admin inbox counts those as unread.
CREATE TABLE contact_messages (
    id         UUID PRIMARY KEY,
    name       VARCHAR(100)  NOT NULL,
    email      VARCHAR(254)  NOT NULL,
    subject    VARCHAR(150),
    message    VARCHAR(5000) NOT NULL,
    locale     VARCHAR(8),
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
    read_at    TIMESTAMPTZ,
    CONSTRAINT chk_contact_messages_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT chk_contact_messages_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
    CONSTRAINT chk_contact_messages_subject_length CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 150),
    CONSTRAINT chk_contact_messages_message_length CHECK (char_length(message) BETWEEN 10 AND 5000),
    CONSTRAINT chk_contact_messages_locale_length CHECK (locale IS NULL OR char_length(locale) BETWEEN 1 AND 8)
);

-- The admin inbox: newest first.
CREATE INDEX idx_contact_messages_created_at ON contact_messages (created_at DESC);

-- The per-address limit counts the rows of one address in the last hour.
CREATE INDEX idx_contact_messages_email_created_at ON contact_messages (lower(email), created_at);
