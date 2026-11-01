/** Module 2 owns courier selection policy, not orders, cash, PIN or Stripe. */
export type DeliveryAssignmentRequest = Readonly<{
  orderId:string;
  restaurantId:string;
  fulfillment:'pickup'|'delivery';
  orderStatus:string;
  deliveryZone:string;
}>;
export type CourierCapacity = Readonly<{
  courierId:string;
  approved:boolean;
  online:boolean;
  serviceZones:readonly string[];
  activeDeliveries:number;
  maxConcurrentDeliveries:number;
  lastSeenAtMs:number;
}>;
export type AssignmentPlan =
  | Readonly<{decision:'ASSIGN';orderId:string;courierId:string}>
  | Readonly<{decision:'NOT_ELIGIBLE'|'NO_AVAILABLE_COURIER';orderId:string}>;
