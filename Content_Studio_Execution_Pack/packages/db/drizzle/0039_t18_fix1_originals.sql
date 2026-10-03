-- FIX-T18 round 1(Codex review-T18): drizzle-kit 출력 + 맨 끝에 손으로 더한 트리거 2개(0005 의 append_only_immutable 재사용).
-- (P0 :293) source_version_originals: 가져온 텍스트 파일의 원본 바이트 그대로(base64, 출처 버전마다 하나, 내보내기·복원 포함). (P2 :339) import_items.byte_size → bigint.
CREATE TABLE "source_version_originals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_version_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"format" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_version_originals_version_uq" UNIQUE("source_version_id"),
	CONSTRAINT "source_version_originals_format_chk" CHECK ("source_version_originals"."format" in ('md', 'txt', 'html', 'csv')),
	CONSTRAINT "source_version_originals_size_chk" CHECK ("source_version_originals"."byte_size" >= 0 and "source_version_originals"."byte_size" <= 2097152 and octet_length(decode("source_version_originals"."content_base64", 'base64')) = "source_version_originals"."byte_size"),
	CONSTRAINT "source_version_originals_sha_chk" CHECK ("source_version_originals"."sha256" ~ '^[0-9a-f]{64}$' and encode(sha256(decode("source_version_originals"."content_base64", 'base64')), 'hex') = "source_version_originals"."sha256")
);
--> statement-breakpoint
ALTER TABLE "import_items" ALTER COLUMN "byte_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "source_version_originals" ADD CONSTRAINT "source_version_originals_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_version_originals" ADD CONSTRAINT "source_version_originals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_version_originals_owner_idx" ON "source_version_originals" USING btree ("owner_id");--> statement-breakpoint
CREATE FUNCTION "source_version_originals_match"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_hash text;
  v_owner uuid;
BEGIN
  SELECT sv.raw_hash, s.owner_id INTO v_hash, v_owner FROM source_versions sv JOIN sources s ON s.id = sv.source_id WHERE sv.id = NEW.source_version_id;
  IF v_hash IS DISTINCT FROM NEW.sha256 OR v_owner IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'source_version_originals_match: 원본 sha256·owner 가 출처 버전(raw_hash)·출처 owner 와 다릅니다' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_version_originals_match" BEFORE INSERT ON "source_version_originals"
  FOR EACH ROW EXECUTE FUNCTION "source_version_originals_match"();--> statement-breakpoint
CREATE TRIGGER "source_version_originals_immutable" BEFORE UPDATE OR DELETE ON "source_version_originals"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
