-- FIX-T10 round 2(Codex review-FIX-T10 0019:26): variant_assets_version_open 트리거가 검사 전에 파생본 행을 FOR UPDATE, 파생본 버전 행을
-- FOR UPDATE 로 잠근다. createPlan 은 파생본을 FOR SHARE 로 잠그고 항목 INSERT 가 버전 행에 FK KEY SHARE 를 잡으므로, 첨부 INSERT 와
-- 계획 생성이 서로 기다린다(먼저 잠근 쪽이 커밋한 뒤 다른 쪽이 커밋된 결과를 본다 — READ COMMITTED 는 잠금 뒤 다음 문장에서 새 스냅샷).
-- 실제 직렬화는 앱 경로(insertCurrentVariantVersion 이 같은 순서로 먼저 잠그고 재검사)가 하고, 이 트리거는 앱 밖 INSERT 에 대한 마지막 방어선이다.
-- 규칙은 0019 와 같다: (a) 배포 항목 스냅샷이 참조하는 버전 거부 (b) 파생본 현재 버전 번호가 더 크면(지나간 옛 버전) 거부.
CREATE OR REPLACE FUNCTION "variant_assets_version_open"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  vv_variant uuid;
  vv_version integer;
  cur_version integer;
BEGIN
  SELECT variant_id INTO vv_variant FROM variant_versions WHERE id = NEW.variant_version_id;
  -- 잠금 순서: variants → variant_versions(createPlan·편집 경로와 같음)
  PERFORM 1 FROM variants WHERE id = vv_variant FOR UPDATE;
  SELECT version INTO vv_version FROM variant_versions WHERE id = NEW.variant_version_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM distribution_items WHERE variant_version_id = NEW.variant_version_id) THEN
    RAISE EXCEPTION 'variant_assets_version_open: 배포 스냅샷이 참조하는 파생본 버전에는 첨부를 추가할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT cv.version INTO cur_version FROM variants v JOIN variant_versions cv ON cv.id = v.current_version_id WHERE v.id = vv_variant;
  IF cur_version IS NOT NULL AND cur_version > vv_version THEN
    RAISE EXCEPTION 'variant_assets_version_open: 지나간(현재보다 옛) 파생본 버전에는 첨부를 추가할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
