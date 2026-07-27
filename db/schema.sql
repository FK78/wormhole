CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    short_code TEXT NOT NULL,
    access_count INT NOT NULL,
    created_at TIMESTAMPTZ DEAFULT NOW(),
    updated_at TIMESTAMPTZ
)