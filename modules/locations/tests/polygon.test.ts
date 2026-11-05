import test from 'node:test';
import assert from 'node:assert/strict';
import {LocationError} from '../src/domain.js';
import {validatePolygon,withinPolygon} from '../src/polygon.js';

const p=(latitude:number,longitude:number)=>({latitude,longitude});
const square=[p(20,-103),p(20,-102.999),p(20.001,-102.999),
 p(20.001,-103)];
function throwsCode(task:()=>unknown,code:string){
 assert.throws(task,e=>e instanceof LocationError&&e.code===code);
}
test('M7 LAB2 polygons: inside, outside, edges, vertices, orientation',()=>{
 const poly=validatePolygon(square);
 assert.equal(withinPolygon(p(20.0005,-102.9995),poly),true);
 assert.equal(withinPolygon(p(20.002,-102.9995),poly),false);
 assert.equal(withinPolygon(p(20,-102.9995),poly),true);
 assert.equal(withinPolygon(p(20,-103),poly),true);
 assert.equal(withinPolygon(p(20.0005,-103),poly),true);
 assert.equal(withinPolygon(p(20.0005,-102.9989),poly),false);
 assert.equal(withinPolygon(p(20.0005,-102.9995),
   validatePolygon([...square].reverse())),true);
});
test('M7 LAB2 rejects untrusted and ambiguous polygon geometry',()=>{
 throwsCode(()=>validatePolygon([p(0,0),p(0,0),p(1,1)]),'M7_POLYGON_INVALID');
 throwsCode(()=>validatePolygon([...square,square[0]]),'M7_POLYGON_INVALID');
 throwsCode(()=>validatePolygon([p(20,-103),p(20.002,-103),
   p(20.001,-102.999),p(20,-102.999),p(20.002,-102.998)]),
   'M7_POLYGON_SELF_INTERSECTION');
 throwsCode(()=>validatePolygon([p(20,-103),p(20.001,-103),
   p(20.002,-103)]),'M7_POLYGON_AREA_INVALID');
 throwsCode(()=>validatePolygon([p(20,-103),p(20,-101.5),
   p(20.001,-101.5)]),'M7_POLYGON_SPAN_INVALID');
 throwsCode(()=>validatePolygon([p(0,-179.9),p(0,179.9),p(0.1,179.9)]),
   'M7_POLYGON_SPAN_INVALID');
 throwsCode(()=>validatePolygon([p(20,-103),p(95,-103),p(21,-104)]),
   'M7_COORDINATES_INVALID');
 throwsCode(()=>validatePolygon([p(20,-103),p(20.0000001,-103),
   p(20.0000002,-103.0000001)]),'M7_POLYGON_INVALID');
 throwsCode(()=>validatePolygon([p(20,-103),p(20,-102.999),p(20.001,-102.999),
   ...Array.from({length:62},(_,i)=>p(20.1+i/10000,-103))]),
   'M7_POLYGON_INVALID');
});
