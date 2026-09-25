-- FIX-T10(Codex review-T10, 결정 D20 후속): drizzle-kit 출력(첫 문장 — distribution_items.restored_needs_review) + 손으로 더한 트리거 2개.
-- (1) restored_needs_review: 복원 때 진행 중이던 항목을 상태(UNKNOWN·BLOCKED)와 별개로 표시한다 — 자동 실행·재시도 금지, 사용자 확인 필요.
-- (2) assets_content_immutable(D19-b): assets.checksum·bytes 는 한 번 정해지면 바꿀 수 없다(파일 교체 = 새 asset). 스냅샷 첨부 checksum 의 뜻을 지킨다.
-- (3) variant_assets_version_open(D19-b): variant_assets INSERT 는 (a) 그 파생본 버전을 배포 항목 스냅샷이 참조하고 있으면 거부,
--     (b) 그 파생본의 현재 버전이 이 버전보다 새 버전이면(= 이미 지나간 옛 버전) 거부. 정상 경로(새 버전 INSERT → 같은 트랜잭션에서 첨부 INSERT →
--     현재 버전 갱신)는 새 버전이 현재보다 새것이라 통과하고, 복원은 파생본 current_version_id 를 모든 표를 넣은 뒤에 연결하므로(그 전까지 NULL) 통과한다.
--     UPDATE·DELETE 는 0009 의 variant_assets_immutable 이 이미 막는다.
ALTER TABLE "distribution_items" ADD COLUMN "restored_needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE FUNCTION "assets_content_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.checksum IS NOT NULL AND NEW.checksum IS DISTINCT FROM OLD.checksum)
    OR (OLD.bytes IS NOT NULL AND NEW.bytes IS DISTINCT FROM OLD.bytes) THEN
    RAISE EXCEPTION 'assets_content_immutable: 파일 checksum·크기는 바꿀 수 없습니다(다른 파일은 새 asset 으로 올리세요)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "assets_content_immutable" BEFORE UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION "assets_content_immutable"();--> statement-breakpoint
CREATE FUNCTION "variant_assets_version_open"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  vv_variant uuid;
  vv_version integer;
  cur_version integer;
BEGIN
  IF EXISTS (SELECT 1 FROM distribution_items WHERE variant_version_id = NEW.variant_version_id) THEN
    RAISE EXCEPTION 'variant_assets_version_open: 배포 스냅샷이 참조하는 파생본 버전에는 첨부를 추가할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT variant_id, version INTO vv_variant, vv_version FROM variant_versions WHERE id = NEW.variant_version_id;
  SELECT cv.version INTO cur_version FROM variants v JOIN variant_versions cv ON cv.id = v.current_version_id WHERE v.id = vv_variant;
  IF cur_version IS NOT NULL AND cur_version > vv_version THEN
    RAISE EXCEPTION 'variant_assets_version_open: 지나간(현재보다 옛) 파생본 버전에는 첨부를 추가할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "variant_assets_version_open" BEFORE INSERT ON "variant_assets"
  FOR EACH ROW EXECUTE FUNCTION "variant_assets_version_open"();
