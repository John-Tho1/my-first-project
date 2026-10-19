CREATE TABLE "live_publish_controls" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"paused" boolean NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	CONSTRAINT "live_publish_controls_changed_by_chk" CHECK ("live_publish_controls"."changed_by" in ('owner'))
);
--> statement-breakpoint
ALTER TABLE "live_publish_controls" ADD CONSTRAINT "live_publish_controls_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;