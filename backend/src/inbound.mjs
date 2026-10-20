// Inbound SMS: AWS End User Messaging publishes each incoming text to an SNS
// topic; this Lambda is subscribed to it.
import { handleInboundSms } from './lib/service.mjs';

export async function handler(event) {
  const out = [];
  for (const rec of event.Records || []) {
    const msg = JSON.parse(rec.Sns.Message);
    const r = await handleInboundSms(msg);
    console.log(JSON.stringify({ msg: 'inbound', from: msg.originationNumber, result: r }));
    out.push(r);
  }
  return out;
}
