-- T07: claim·근거(claims, claim_sources)와 AI 비용 원장(usage_ledger), 결정 D13.
-- drizzle-kit 출력에 claims·claim_sources 의 추가 전용 트리거(0005 의 append_only_immutable 함수 재사용)만 맨 끝에 덧붙였다.
-- usage_ledger 는 reserved → settled 로 갱신되므로 트리거를 두지 않는다.
CREATE TABLE "claim_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"locator" text,
	"support_note" text,
	CONSTRAINT "claim_sources_claim_source_uq" UNIQUE("claim_id","source_version_id")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_index" integer NOT NULL,
	"statement" text NOT NULL,
	"kind" text NOT NULL,
	"evidence_grade" text NOT NULL,
	"personal_experience_confirmed" boolean DEFAULT false NOT NULL,
	"needs_check" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "claims_version_index_uq" UNIQUE("content_version_id","claim_index"),
	CONSTRAINT "claims_evidence_grade_chk" CHECK ("claims"."evidence_grade" in ('none', 'source', 'user_confirmed')),
	CONSTRAINT "claims_kind_chk" CHECK ("claims"."kind" in ('fact', 'opinion', 'experience'))
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reserved_amount" numeric(18, 6) NOT NULL,
	"actual_amount" numeric(18, 6),
	"currency" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"pricing_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "usage_ledger_run_uq" UNIQUE("run_id"),
	CONSTRAINT "usage_ledger_state_chk" CHECK ("usage_ledger"."state" in ('reserved', 'settled', 'released'))
);
--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_claim_same_owner_fk" FOREIGN KEY ("claim_id","owner_id") REFERENCES "public"."claims"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_content_version_id_content_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_run_same_owner_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."generation_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_same_owner_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."generation_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_ledger_owner_created_idx" ON "usage_ledger" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE TRIGGER "claims_immutable" BEFORE UPDATE OR DELETE ON "claims"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();--> statement-breakpoint
CREATE TRIGGER "claim_sources_immutable" BEFORE UPDATE OR DELETE ON "claim_sources"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
