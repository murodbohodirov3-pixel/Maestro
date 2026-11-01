-- The bins are photographed close, from above (owner's decision of
-- 2026-11-01). On 30.10 a full kitchen bin passed when shot from across the
-- room, and the toilet bin passed as the kitchen one. The check now knows each
-- bin by sight and refuses a bin small in the distance; the master reads the
-- same rule under the zone's name.

update public.duty_zones
set checklist_ru = 'вблизи и сверху, чтобы было видно, что внутри',
    checklist_uz = 'yaqindan va tepadan, ichi koʻrinsin'
where id = 'kitchen_bin';

update public.duty_zones
set checklist_ru = 'вблизи и сверху, крышка открыта, чтобы было видно, что внутри',
    checklist_uz = 'yaqindan va tepadan, qopqogʻi ochiq, ichi koʻrinsin'
where id = 'toilet_bin';
