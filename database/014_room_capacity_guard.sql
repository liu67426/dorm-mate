-- 数据库最后一道容量检查：跨班机动寝室不能因分班发布而重复占床。
CREATE OR REPLACE FUNCTION public.dorm_check_room_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_capacity integer;
  v_occupied integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.room_number = OLD.room_number THEN RETURN NEW; END IF;
  END IF;
  -- 锁定寝室行，使并发发布不能同时认为还剩同一张空床。
  SELECT capacity INTO v_capacity FROM public.dorm_rooms
  WHERE room_number = NEW.room_number AND active = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '寝室不存在或已停用'; END IF;
  SELECT count(*) INTO v_occupied FROM public.dorm_assignments
  WHERE room_number = NEW.room_number AND student_id <> NEW.student_id;
  IF v_occupied >= v_capacity THEN RAISE EXCEPTION '寝室 % 已满，禁止发布超员结果', NEW.room_number; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dorm_assignments_capacity_guard ON public.dorm_assignments;
CREATE TRIGGER dorm_assignments_capacity_guard
BEFORE INSERT OR UPDATE OF room_number ON public.dorm_assignments
FOR EACH ROW EXECUTE FUNCTION public.dorm_check_room_capacity();
