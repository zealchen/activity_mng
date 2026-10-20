// Outbound channels and file storage. Everything that talks to SNS/SES/S3 or
// AWS End User Messaging lives here so the rest of the code stays testable.
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const sns = new SNSClient({});
const ses = new SESClient({});
const s3 = new S3Client({ forcePathStyle: true });

/**
 * SMS_PROVIDER=sns (default; LocalStack captures these at /_aws/sns/sms-messages)
 * SMS_PROVIDER=eum (production: AWS End User Messaging with a registered
 *                   toll-free number in SMS_ORIGINATION)
 */
export async function sendSms(to, body) {
  if ((process.env.SMS_PROVIDER || 'sns') === 'eum') {
    const { PinpointSMSVoiceV2Client, SendTextMessageCommand } = await import('@aws-sdk/client-pinpoint-sms-voice-v2');
    const c = new PinpointSMSVoiceV2Client({});
    const r = await c.send(new SendTextMessageCommand({
      DestinationPhoneNumber: to, OriginationIdentity: process.env.SMS_ORIGINATION,
      MessageBody: body, MessageType: 'TRANSACTIONAL',
    }));
    return r.MessageId;
  }
  const r = await sns.send(new PublishCommand({
    PhoneNumber: to, Message: body,
    MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } },
  }));
  return r.MessageId;
}

export async function sendEmail(to, subject, body) {
  const r = await ses.send(new SendEmailCommand({
    Source: process.env.SENDER_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: body, Charset: 'UTF-8' } } },
  }));
  return r.MessageId;
}

/** Used by the dev phone simulator: inject a text exactly as AWS End User Messaging would. */
export async function publishInboundSms(from, body) {
  const payload = {
    originationNumber: from,
    destinationNumber: process.env.SMS_NUMBER || '+18005550199',
    messageKeyword: 'KEYWORD_LOCAL',
    messageBody: body,
    inboundMessageId: `local-${Date.now()}`,
  };
  await sns.send(new PublishCommand({ TopicArn: process.env.INBOUND_TOPIC_ARN, Message: JSON.stringify(payload) }));
  return payload;
}

export async function putFile(key, buf, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: process.env.FILES_BUCKET, Key: key, Body: buf, ContentType: contentType }));
}

export async function getFile(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: process.env.FILES_BUCKET, Key: key }));
  return { body: Buffer.from(await r.Body.transformToByteArray()), contentType: r.ContentType };
}
