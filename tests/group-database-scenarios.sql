-- 仅在 check-group-database.mjs 的回滚事务中运行。只操作本次随机前缀的虚构记录。
DO $qa$
DECLARE
  p text := '__groupqa_' || md5(random()::text || clock_timestamp()::text);
  i integer;
  state jsonb;
  result jsonb;
BEGIN
  FOR i IN 1..15 LOOP
    INSERT INTO public.dorm_students(id,class_id,class_name,class_code,student_id,name,auth_uid,survey_completed,gender)
    VALUES(p||i,CASE WHEN i=6 THEN '2' ELSE '1' END,'事务测试班','01',p||'sid'||i,'回滚测试学生',p||'uid'||i,i<>8,CASE WHEN i=7 THEN '女' ELSE '男' END);
  END LOOP;
  -- A 邀请 B；B 在接受前也发过邀请，形成两个单人临时记录。
  PERFORM set_config('request.jwt.claim.sub',p||'uid1',true);
  PERFORM public.dorm_create_invite('不信任传入身份',p||2,p||'g1',p||'i12');
  IF (SELECT cardinality(member_ids) FROM dorm_groups WHERE id=p||'g1')<>1 THEN RAISE EXCEPTION 'QA:邀请未接受却增加成员'; END IF;
  PERFORM public.dorm_create_invite('',p||2,p||'unused',p||'duplicate');
  IF (SELECT count(*) FROM dorm_invitations WHERE group_id=p||'g1' AND to_student_id=p||2)<>1 THEN RAISE EXCEPTION 'QA:重复发邀请未去重'; END IF;
  PERFORM set_config('request.jwt.claim.sub',p||'uid2',true);
  PERFORM public.dorm_create_invite('',p||3,p||'g2',p||'i23');
  PERFORM set_config('request.jwt.claim.sub',p||'uid3',true);
  state := public.dorm_student_state();
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'candidates') c WHERE c->>'id'=p||2) THEN RAISE EXCEPTION 'QA:单人临时组学生未进入候选'; END IF;
  BEGIN
    PERFORM public.dorm_respond_invite('',p||'i12',true);
    RAISE EXCEPTION 'QA:允许越权接受邀请';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%邀请不存在或已经处理%' THEN RAISE; END IF;
  END;
  -- B 接受 A，旧单人组退役但保留邀请历史。
  PERFORM set_config('request.jwt.claim.sub',p||'uid2',true);
  PERFORM public.dorm_respond_invite('',p||'i12',true);
  IF (SELECT member_ids FROM dorm_groups WHERE id=p||'g1')<>ARRAY[p||1,p||2] THEN RAISE EXCEPTION 'QA:未形成二人搭档'; END IF;
  IF (SELECT cardinality(member_ids) FROM dorm_groups WHERE id=p||'g2')<>0 THEN RAISE EXCEPTION 'QA:旧单人组仍占用成员'; END IF;
  IF (SELECT status FROM dorm_invitations WHERE id=p||'i23')<>'cancelled' THEN RAISE EXCEPTION 'QA:旧邀请未保留并取消'; END IF;
  BEGIN
    PERFORM public.dorm_respond_invite('',p||'i12',true);
    RAISE EXCEPTION 'QA:重复接受邀请';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%邀请不存在或已经处理%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub',p||'uid3',true);
  BEGIN
    PERFORM public.dorm_create_invite('',p||2,p||'bad',p||'bad');
    RAISE EXCEPTION 'QA:拆散已有多人组';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%对方已经加入多人小组%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub',p||'uid1',true);
  BEGIN
    PERFORM public.dorm_create_invite('',p||6,p||'bad6',p||'bad6');
    RAISE EXCEPTION 'QA:跨班邀请';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%只能邀请同班%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.dorm_create_invite('',p||7,p||'bad7',p||'bad7');
    RAISE EXCEPTION 'QA:不同性别邀请';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%同性别%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.dorm_create_invite('',p||8,p||'bad8',p||'bad8');
    RAISE EXCEPTION 'QA:邀请未填问卷者';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%尚未完成问卷%' THEN RAISE; END IF; END;
  PERFORM public.dorm_create_invite('',p||3,p||'unused3',p||'i13');
  PERFORM public.dorm_create_invite('',p||4,p||'unused4',p||'i14');
  PERFORM public.dorm_create_invite('',p||5,p||'unused5',p||'i15');
  state := public.dorm_student_state();
  IF jsonb_array_length(state->'outgoingInvites')<>3 THEN RAISE EXCEPTION 'QA:未返回真实待确认邀请'; END IF;
  PERFORM set_config('request.jwt.claim.sub',p||'uid3',true);
  PERFORM public.dorm_respond_invite('',p||'i13',true);
  IF (SELECT status FROM dorm_groups WHERE id=p||'g1')<>'forming' THEN RAISE EXCEPTION 'QA:三人被错误标为完整'; END IF;
  PERFORM set_config('request.jwt.claim.sub',p||'uid4',true);
  PERFORM public.dorm_respond_invite('',p||'i14',true);
  IF NOT EXISTS(SELECT 1 FROM dorm_groups WHERE id=p||'g1' AND status='complete' AND cardinality(member_ids)=4 AND member_ids<@confirmed_ids) THEN RAISE EXCEPTION 'QA:四人全确认未完整'; END IF;
  IF (SELECT status FROM dorm_invitations WHERE id=p||'i15')<>'cancelled' THEN RAISE EXCEPTION 'QA:满员后仍可接受旧邀请'; END IF;
  PERFORM set_config('request.jwt.claim.sub',p||'uid5',true);
  BEGIN
    PERFORM public.dorm_respond_invite('',p||'i15',true);
    RAISE EXCEPTION 'QA:第五人进入满员组';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%邀请不存在或已经处理%' THEN RAISE; END IF; END;
  -- 另一组：单人带着历史邀请申请加入二人组，再接纳一人凑满。
  PERFORM set_config('request.jwt.claim.sub',p||'uid9',true);
  PERFORM public.dorm_create_invite('',p||10,p||'g9',p||'i910');
  PERFORM set_config('request.jwt.claim.sub',p||'uid10',true);
  PERFORM public.dorm_respond_invite('',p||'i910',true);
  PERFORM set_config('request.jwt.claim.sub',p||'uid11',true);
  PERFORM public.dorm_create_invite('',p||12,p||'g11',p||'i1112');
  PERFORM public.dorm_request_join_group(p||'g9',p||'j11');
  PERFORM set_config('request.jwt.claim.sub',p||'uid10',true);
  PERFORM public.dorm_respond_join_request(p||'j11',true);
  IF (SELECT cardinality(member_ids) FROM dorm_groups WHERE id=p||'g9')<>3 THEN RAISE EXCEPTION 'QA:申请加入未形成三人组'; END IF;
  IF (SELECT status FROM dorm_invitations WHERE id=p||'i1112')<>'cancelled' THEN RAISE EXCEPTION 'QA:加入后旧邀请未取消'; END IF;
  PERFORM set_config('request.jwt.claim.sub',p||'uid12',true);
  PERFORM public.dorm_request_join_group(p||'g9',p||'j12');
  PERFORM set_config('request.jwt.claim.sub',p||'uid13',true);
  PERFORM public.dorm_request_join_group(p||'g9',p||'j13');
  BEGIN
    PERFORM public.dorm_respond_join_request(p||'j12',true);
    RAISE EXCEPTION 'QA:非成员审批加入申请';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%只有该小组现有成员%' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub',p||'uid9',true);
  PERFORM public.dorm_respond_join_request(p||'j12',true);
  IF (SELECT status FROM dorm_join_requests WHERE id=p||'j13')<>'cancelled' THEN RAISE EXCEPTION 'QA:满员后申请未取消'; END IF;
  IF EXISTS(SELECT member_id FROM dorm_groups g CROSS JOIN LATERAL unnest(g.member_ids) member_id WHERE g.id LIKE p||'%' GROUP BY member_id HAVING count(*)>1) THEN RAISE EXCEPTION 'QA:同一学生属于多个组'; END IF;
  -- 未登录和空选择都不能执行接受操作。
  BEGIN
    PERFORM public.dorm_respond_invite('',p||'i12',NULL);
    RAISE EXCEPTION 'QA:空选择当成同意';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%请选择接受或拒绝%' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  BEGIN
    PERFORM public.dorm_student_state();
    RAISE EXCEPTION 'QA:未登录读取数据';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%请先登录%' THEN RAISE; END IF; END;
END;
$qa$;
