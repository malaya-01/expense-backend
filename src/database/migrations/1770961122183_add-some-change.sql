-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.test_migration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    input_text text NOT NULL,
    processed_text text,
    actual_category_id uuid,
    predicted_category_id uuid,
    confidence numeric(3,2),
    user_corrected boolean,
    correction_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);
-- Down Migration