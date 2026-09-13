-- 清理名单重导后遗留的失效组员编号，避免已填问卷学生在分寝时被静默漏掉。
UPDATE public.dorm_groups AS g
SET member_ids = COALESCE((
  SELECT array_agg(valid_member.member_id ORDER BY valid_member.position)
  FROM (
    SELECT item.member_id, min(item.position) AS position
    FROM unnest(g.member_ids) WITH ORDINALITY AS item(member_id, position)
    JOIN public.dorm_students AS student
      ON student.id = item.member_id AND student.class_id = g.class_id
    GROUP BY item.member_id
  ) AS valid_member
), ARRAY[]::text[]),
updated_at = now();

UPDATE public.dorm_groups AS g
SET confirmed_ids = COALESCE((
  SELECT array_agg(valid_confirmation.member_id ORDER BY valid_confirmation.position)
  FROM (
    SELECT item.member_id, min(item.position) AS position
    FROM unnest(g.confirmed_ids) WITH ORDINALITY AS item(member_id, position)
    WHERE item.member_id = ANY(g.member_ids)
    GROUP BY item.member_id
  ) AS valid_confirmation
), ARRAY[]::text[]),
updated_at = now();

UPDATE public.dorm_groups
SET status = CASE
  WHEN cardinality(member_ids) = 4 AND member_ids <@ confirmed_ids THEN 'complete'
  ELSE 'forming'
END,
updated_at = now();

UPDATE public.dorm_students AS student
SET group_id = NULL
WHERE student.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.dorm_groups AS g
    WHERE g.id = student.group_id AND student.id = ANY(g.member_ids)
  );
