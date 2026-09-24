-- T03: 수정 버전(revision)·수정 이력·원문 해시·정규화 URL.
-- 주의: captures_id_owner_uq 는 capture_revisions 복합 FK 보다 먼저 만들어야 해서 drizzle-kit 출력 순서를 손으로 옮겼다.
-- content_hash 는 SQL 로 backfill 하지 않는다(NFC·공백 정규화를 SQL 로 똑같이 재현할 수 없음). seed/createCapture 가 채운다.
CREATE TABLE "capture_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"user_note" text,
	"risk" text NOT NULL,
	"title" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	CONSTRAINT "capture_revisions_capture_revision_uq" UNIQUE("capture_id","revision")
);
--> statement-breakpoint
ALTER TABLE "source_versions" ALTER COLUMN "raw_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "normalized_url" text;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_id_owner_uq" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "capture_revisions" ADD CONSTRAINT "capture_revisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_revisions" ADD CONSTRAINT "capture_revisions_capture_same_owner_fk" FOREIGN KEY ("capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_owner_content_hash_idx" ON "captures" USING btree ("owner_id","content_hash");--> statement-breakpoint
CREATE INDEX "captures_owner_received_idx" ON "captures" USING btree ("owner_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sources_owner_normalized_url_uq" ON "sources" USING btree ("owner_id","normalized_url") WHERE "sources"."normalized_url" is not null;