-- T04: 콘텐츠 카드(ideas)·원고(contents) 메타데이터, 원문 관계(content_captures·idea_captures), 불변 버전 트리거, 검색 색인.
-- 손으로 조정한 부분(drizzle-kit 출력 대비):
--  1) pg_trgm 확장 생성(맨 앞). PGlite 는 createDb 에서 contrib/pg_trgm 을 등록해야 한다.
--  2) contents_id_owner_uq 를 content_captures 복합 FK 보다 먼저 만들도록 옮겼다.
--  3) ideas.source_capture_ids(jsonb) 를 지우기 전에 같은 owner 의 capture 만 idea_captures 로 옮긴다(T04 이전에는 idea 생성 경로가 없어 보통 0행).
--  4) content_versions UPDATE·DELETE 를 막는 트리거 content_versions_immutable(맨 끝).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "content_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"role" text DEFAULT 'origin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_captures_content_capture_uq" UNIQUE("content_id","capture_id")
);
--> statement-breakpoint
CREATE TABLE "idea_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"role" text DEFAULT 'origin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_captures_idea_capture_uq" UNIQUE("idea_id","capture_id")
);
--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "evidence" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "next_decision" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_id_owner_uq" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "content_captures" ADD CONSTRAINT "content_captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_captures" ADD CONSTRAINT "content_captures_content_same_owner_fk" FOREIGN KEY ("content_id","owner_id") REFERENCES "public"."contents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_captures" ADD CONSTRAINT "content_captures_capture_same_owner_fk" FOREIGN KEY ("capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_captures" ADD CONSTRAINT "idea_captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_captures" ADD CONSTRAINT "idea_captures_idea_same_owner_fk" FOREIGN KEY ("idea_id","owner_id") REFERENCES "public"."ideas"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_captures" ADD CONSTRAINT "idea_captures_capture_same_owner_fk" FOREIGN KEY ("capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_captures_capture_idx" ON "content_captures" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "idea_captures_capture_idx" ON "idea_captures" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "captures_raw_text_trgm_idx" ON "captures" USING gin ("raw_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "content_versions_body_trgm_idx" ON "content_versions" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contents_owner_updated_idx" ON "contents" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contents_title_trgm_idx" ON "contents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ideas_owner_updated_idx" ON "ideas" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ideas_idea_trgm_idx" ON "ideas" USING gin ("idea" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_lifecycle_chk" CHECK ("contents"."lifecycle" in ('draft', 'review', 'ready', 'archived'));--> statement-breakpoint
INSERT INTO "idea_captures" ("idea_id", "capture_id", "owner_id")
SELECT i."id", c."id", i."owner_id"
  FROM "ideas" i
  CROSS JOIN LATERAL jsonb_array_elements_text(i."source_capture_ids") AS s(cid)
  JOIN "captures" c ON c."id"::text = s.cid AND c."owner_id" = i."owner_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "ideas" DROP COLUMN "source_capture_ids";--> statement-breakpoint
CREATE FUNCTION "content_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content_versions_immutable: content_versions 행은 수정·삭제할 수 없습니다(새 버전을 추가하세요)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "content_versions_immutable" BEFORE UPDATE OR DELETE ON "content_versions"
  FOR EACH ROW EXECUTE FUNCTION "content_versions_immutable"();
