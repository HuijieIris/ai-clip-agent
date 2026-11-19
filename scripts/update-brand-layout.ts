/** Restore canvas dimensions from original uploaded artwork. */
import { projects, templates, transaction, DATA_DIR } from '../apps/server/src/store'
import { adaptCanvasToFrame } from '../apps/server/src/branding/service'
import { applyAutoLayout } from '../apps/server/src/packaging/autolayout'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const affected=templates.all().filter(t=>t.name==='知识区竖屏包框')
const before=projects.all().filter(p=>affected.some(t=>t.id===p.brand?.template.id))
writeFileSync(join(DATA_DIR,'backups',`brand-layout-${Date.now()}.json`),JSON.stringify({templates:affected,projects:before},null,2))
for(const t of affected){
 await adaptCanvasToFrame(t)
 t.version=(t.version??1)+1
 for(const p of before.filter(p=>p.brand?.template.id===t.id)){
  p.brand!.template=structuredClone(t);p.brand!.revision++
  for(const c of p.clips){if(!c.packaging)continue;delete c.packaging.frameLayout;await applyAutoLayout(c.packaging,t)}
 }
}
transaction(()=>{for(const t of affected)templates.put(t);for(const p of before)projects.put(p)})
console.log(JSON.stringify({templates:affected.length,projects:before.length,canvas:affected.map(t=>t.canvas)}))
