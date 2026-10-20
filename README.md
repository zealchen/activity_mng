# Activity Manager

Runs a recurring volunteer event from a reusable **playbook**: who does what, when,
with the exact texts and emails, shopping lists, volunteer shifts, a results form
and an expense report. Built for teams whose members prefer text messages, email
and phone calls over apps.

The first playbook is the **God's Special Children Christmas Mass & Party**,
rebuilt from the 2025 run (`GSC2025.pdf`).

## How it works

```
playbook (roles, tasks at T-n days, message templates, checklists, shopping, shifts, results form)
   │  create event: pick a date, put people into roles
   ▼
event ──► task's time comes: "Ready to send" on the dashboard
                │  coordinator presses Send
                ▼
         email with a personal link ──► tap Done / I need help on the page
                │
                │  no reply 48h: dashboard asks the coordinator to send a reminder
                │  no reply 72h: dashboard asks the coordinator to call
                ▼
         coordinator dashboard  ◄──  personal page (big buttons, checklists,
                                      shopping list, results form, receipt photos)
```

* **You press Send** - nothing goes out by itself. When a task's time comes it
  appears under *Ready to send* on the Overview (one Send per task, or Send all).
  No reply in 48h: the Overview offers *Send reminder*. No reply in 72h, or no
  email on file: the person is on your call list. There is no background scheduler.
* **Personal links** - no logins. Each person gets one link per event.
* **Contacts** - everyone, core team and volunteers, is on one contact list
  shared by all events; roles, volunteer shifts and announcements pick from it.
  The coordinator signs volunteers up - there is no public sign-up.
* **Adjust the plan per event** - on *Tasks & timeline* add, edit (times, phase,
  roles, checklist, texts) or delete tasks; on *Team & roles* add, rename or
  delete roles. **Export PDF** gives a who-does-what-when timeline to share for
  review. Saving the playbook for next year keeps all of these changes.
* **Email first** - the system reaches people by email; anyone without an email
  is put on the coordinator's call list. Announcements has **Copy phone numbers**
  for texting a group from your own phone. Automatic texts are off by default and
  can be turned on per event (Contacts page) once an SMS number is registered;
  then people can also reply `1` (done), `2 <note>` (need help), `HELP`, `STOP`. Landline-only people are never texted; the
  coordinator gets a "please call" alert instead.
* **Announcements** - one sentence to chosen roles, shift volunteers or people; anyone not confirming
  within 24h lands on the coordinator's call list.
* **Next year** - "Save playbook for next year" turns this event (edits, results,
  quantities, lessons) into a new playbook version.

## Architecture (AWS)

| Piece | Service |
|---|---|
| Dashboard, personal pages | S3 static site (CloudFront in production) |
| API | API Gateway HTTP API -> Lambda `activity-mng-api` |
| Inbound texts | SNS topic -> Lambda `activity-mng-inbound` |
| Outbound texts | SNS (local) / AWS End User Messaging (production, `SMS_PROVIDER=eum`) |
| Email | SES |
| Data | DynamoDB single table; receipts in S3 |

Code: `backend/src` (Node 22, `lib/engine.mjs` holds all scheduling rules as pure
functions), `web/`, `playbooks/`, `infra/` (Terraform: shared `modules/app`,
`local/` for LocalStack, `cloud/dev/` for AWS).

## Run it locally (LocalStack Pro)

Needs Docker, Terraform, Node 20+, the AWS CLI, and `LOCALSTACK_AUTH_TOKEN` in
`~/.genesis/config`.

```bash
scripts/up.sh            # start LocalStack on :4666, deploy, load the GSC 2026 data
scripts/up.sh --reset    # wipe everything and start fresh
scripts/verify.sh        # unit tests + fresh deploy + end-to-end flow + re-seed
scripts/down.sh          # stop and delete
```

Dashboard: <http://activity-mng-web.s3-website.localhost.localstack.cloud:4666/index.html>
- admin key `local-admin`.

Local dev mode adds a **simulated clock** (top-right: `+1 day`, `+1 week`,
`Next task`) and the **Phone & email simulator** page, where you
see each person's texts and inbox and reply as them. Replies go through the real
inbound path (SNS -> Lambda). LocalStack's own records: `http://localhost:4666/_aws/ses`
and `http://localhost:4666/_aws/sns/sms-messages`.

## Walkthrough (about 20 minutes)

1. **Overview** - the coordinator's to-do and the unassigned **Santa** role.
2. **Contacts** - add a person (e.g. "Bob Santa", with an email). On **Team & roles**
   tick him under *Santa*, **Save roles**. Once the Santa task's time has come it
   is under **Ready to send** on the Overview.
3. Click **Next task** a few times (or set a date). Tasks pile up under **Ready to
   send**; open one to preview the email, press **Send** (or **Send all**). In the
   **Phone & email simulator** pick *CJ* to read the Hall reservation email. Pick
   *Cat*, open the link in her email and tap **Done**.
4. Click **+1 week**: unanswered tasks move to **Send a reminder**, then to
   **Call needed**. *Gail* (landline) is on the call list as soon as her task's
   time comes - there is nothing to send her.
5. **Announcements** - send "Set-up now starts at 2:30 PM" to Knights and
   Daughters liaisons. Confirm from Alan's email link, then **+1 day**: the others
   appear on the call list. **Copy phone numbers** gives you the group for a text.
6. Move to about **Nov 20** and send Kent the inventory check. In the simulator,
   open the link in his email: tick a few items, tap **I need help**. Back on the
   Overview, his request and phone number are at the top.
7. **Volunteer shifts** - add a volunteer on **Contacts**, then pick them for a
   shift. Everyone (core team and volunteers) lives on the contact list first;
   roles, shifts and announcements all pick from it.
8. Around **Nov 27** - send Kent's Sam's shopping list; tick items on his page and
   watch **Shopping list** fill in.
9. Set the time to **Dec 6, 4:01 PM** - send Cat the results form; fill it in
   from her link (question marks are refused).
10. **+1 day** - send the receipts task; Kent uploads a receipt photo from his page.
11. **Results & report** - totals, "please pay", **Print report**, then **Save
    playbook for next year**. Under *All events & playbooks* create a 2027 event
    from version 2.

`scripts/up.sh --reset` gives you a clean slate any time.

## Deploy to AWS (dev)

One cloud environment, `dev`: account 905418107398, us-east-1, resources named
`activity-mng-dev-*`. Config is `infra/cloud/dev/terraform.tfvars` (committed,
no secrets); state is in S3 `activity-mng-dev-tfstate` (versioned, S3 lockfile).

```bash
AWS_PROFILE=neo scripts/bootstrap-cloud.sh      # first time (and any time): state bucket, apply, GitHub wiring
AWS_PROFILE=neo scripts/teardown-dev.sh         # destroy dev - data and receipts included
AWS_PROFILE=neo scripts/teardown-dev.sh --purge # ... and the state bucket too
```

`bootstrap-cloud.sh` creates the GitHub `dev` environment with `AWS_ACCOUNT_ID`,
`AWS_DEPLOY_ROLE_ARN` (GitHub OIDC, no AWS keys in GitHub) and `ADMIN_KEY`, and
sets the repo variable `AUTO_PUBLISH=false`. CI does not run the LocalStack e2e
suite (it needs LocalStack Pro); run it locally before merging.

CI (`.github/workflows`):

| Workflow | When | What |
|---|---|---|
| `pr.yml` | every PR into `main` | unit tests, `terraform fmt`/`validate`, dev plan as a PR comment |
| `publish.yml` | Actions -> Publish, or push to `main` when `AUTO_PUBLISH=true` | the same checks, then plan -> high-risk gate -> apply -> `/health` smoke |

The high-risk gate refuses a plan that deletes or replaces the DynamoDB table or
an S3 bucket unless the run ticks `allow_destroy` or the commit message has
`[tf-allow-destroy]`.

## Going to production - open items

* **SMS number** (only if you want automatic texts): register a toll-free number in AWS End User Messaging
  (verification takes 1-4 weeks), enable two-way SMS to the inbound SNS topic,
  set `sms_provider = "eum"` and `sms_origination`. Get members' consent to texts.
* **Email**: verify the sending domain in SES (production access is already on) and
  switch `sender_email` to an address on it.
* **Sign-in**: replace the shared admin key with Cognito.
* **Hosting**: put CloudFront (HTTPS) in front of the S3 site; short links help in texts.
