import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RestaurantError,uuid,field,slug,integer,member,KINDS,CITIES,
  digest,assertKeys} from '../src/domain.js';
test('M6 fixed input contracts: UUID, slug, location, store category and integer centavos',()=>{
  const id=randomUUID();
  assert.equal(uuid(id.toUpperCase()),id);
  assert.throws(()=>uuid('someone@example.com'));
  assert.equal(slug('carniceria-la-terraza'),'carniceria-la-terraza');
  assert.throws(()=>slug('Not a URL'));
  assert.equal(field(' Tacos ',2,100),'Tacos');
  assert.equal(integer(39900,1,100000000,'M6_PRICE_INVALID'),39900);
  assert.throws(()=>integer(399.5,1,100000000,'M6_PRICE_INVALID'));
  assert.throws(()=>integer(-1,1,100000000,'M6_PRICE_INVALID'));
  for(const city of CITIES)assert.equal(member(city,CITIES,'X'),city);
  for(const kind of KINDS)assert.equal(member(kind,KINDS,'X'),kind);
  assert.throws(()=>member('casino',KINDS,'M6_KIND_INVALID'),
    (e:unknown)=>e instanceof RestaurantError&&e.code==='M6_KIND_INVALID');
  assert.equal(digest({a:2}),digest({a:2}));
  assert.notEqual(digest({a:2}),digest({a:3}));
  assert.throws(()=>assertKeys({role:'owner'},['price']));
});
test('M6 refuses unsafe control characters and excess text length',()=>{
  assert.throws(()=>field('ok\u0000bad',2,80));
  assert.throws(()=>field(' '.repeat(12),2,80));
  assert.throws(()=>field('x'.repeat(200),2,80));
});
