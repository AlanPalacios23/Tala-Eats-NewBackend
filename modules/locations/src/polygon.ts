/** M7 LAB2 local geofences: pure geometry only.
 * No maps provider, merchant eligibility, driver paths or delivery routing.
 * Polygons are operator-defined LAB geometry, not externally verified borders.
 */
import {LocationError,point,type Point} from './domain.js';

export type Polygon=readonly Point[];
const EPS=1e-11;
const cross=(a:Point,b:Point,c:Point)=>
  (b.longitude-a.longitude)*(c.latitude-a.latitude)-
  (b.latitude-a.latitude)*(c.longitude-a.longitude);

function onSegment(p:Point,a:Point,b:Point){
  return Math.abs(cross(a,b,p))<=EPS&&
    p.longitude>=Math.min(a.longitude,b.longitude)-EPS&&
    p.longitude<=Math.max(a.longitude,b.longitude)+EPS&&
    p.latitude>=Math.min(a.latitude,b.latitude)-EPS&&
    p.latitude<=Math.max(a.latitude,b.latitude)+EPS;
}
function intersects(a:Point,b:Point,c:Point,d:Point){
  const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
  if((x>EPS&&y< -EPS||x< -EPS&&y>EPS)&&
     (z>EPS&&w< -EPS||z< -EPS&&w>EPS))return true;
  return Math.abs(x)<=EPS&&onSegment(c,a,b)||
    Math.abs(y)<=EPS&&onSegment(d,a,b)||
    Math.abs(z)<=EPS&&onSegment(a,c,d)||
    Math.abs(w)<=EPS&&onSegment(b,c,d);
}

/** Simple ring without duplicated closing vertex, holes or antimeridian wrap.
 * Maximum 1° per axis keeps the local planar geofence approximation bounded.
 */
export function validatePolygon(value:unknown):Polygon{
  if(!Array.isArray(value)||value.length<3||value.length>64)
    throw new LocationError('M7_POLYGON_INVALID');
  const ring=value.map(v=>point(v));
  const seen=new Set<string>();
  for(const v of ring){
    const key=v.latitude+','+v.longitude;
    if(seen.has(key))throw new LocationError('M7_POLYGON_INVALID');
    seen.add(key);
  }
  const lat=ring.map(x=>x.latitude),lon=ring.map(x=>x.longitude);
  const minLat=Math.min(...lat),maxLat=Math.max(...lat),
    minLon=Math.min(...lon),maxLon=Math.max(...lon);
  if(maxLat-minLat>1||maxLon-minLon>1)
    throw new LocationError('M7_POLYGON_SPAN_INVALID');
  const n=ring.length;
  for(let i=0;i<n;i++){
    const a=ring[i]!,b=ring[(i+1)%n]!;
    for(let j=i+1;j<n;j++){
      if(j===i+1||(i===0&&j===n-1))continue; // adjacent edges
      const c=ring[j]!,d=ring[(j+1)%n]!;
      if(intersects(a,b,c,d))
        throw new LocationError('M7_POLYGON_SELF_INTERSECTION');
    }
  }
  let twice=0;
  for(let i=0;i<n;i++){
    const a=ring[i]!,b=ring[(i+1)%n]!;
    twice+=(a.longitude*b.latitude-b.longitude*a.latitude);
  }
  // Longitude degree size is latitude-dependent; square metres approximate.
  const area=Math.abs(twice)*0.5*(111195**2)*
    Math.abs(Math.cos((minLat+maxLat)*0.5*Math.PI/180));
  if(!Number.isFinite(area)||area<100)
    throw new LocationError('M7_POLYGON_AREA_INVALID');
  return Object.freeze(ring.map(x=>Object.freeze(x)));
}

/** Boundary is included; consistent with circle's <= radius semantics. */
export function withinPolygon(candidate:Point,vertices:Polygon):boolean{
  const p=point(candidate);
  // Trusted stored geometry is validated once at write, and validated on read
  // before geographic decisions to prevent invalid SQL data entering results.
  if(vertices.length<3)return false;
  let inside=false;
  for(let i=0,j=vertices.length-1;i<vertices.length;j=i++){
    const a=vertices[j]!,b=vertices[i]!;
    if(onSegment(p,a,b))return true;
    if((a.latitude>p.latitude)!==(b.latitude>p.latitude)){
      const edgeLon=a.longitude+(p.latitude-a.latitude)*
        (b.longitude-a.longitude)/(b.latitude-a.latitude);
      if(p.longitude<edgeLon)inside=!inside;
    }
  }
  return inside;
}
