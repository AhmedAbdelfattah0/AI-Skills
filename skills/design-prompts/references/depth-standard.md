# Depth standard: how detailed a prompt must be

Claude Design fills every gap with a generic guess. A prompt is detailed enough when a designer who has never seen the product could build every screen without asking a question. Apply this standard to every prompt you write (and put it in the writer brief when delegating), then run the self-check at the end before delivering.

The snippets below use a made-up product ("a booking app for a yoga studio") only to show the level of detail. Never copy their content into a real project.

## 1. Minimum per page

Every page in "Key page details" states all of these, or says explicitly that one does not apply:

| Item | What to write |
|---|---|
| Purpose | One line: who is here and what job they finish on this page |
| Sections | Top to bottom, each with the real data it shows |
| Data | Field names, table columns (in order), badges and which statuses they show, formats (money, dates, IDs) |
| Filters and sorting | Each filter with its options and default |
| Actions | Every button and link: label, what it opens or does, who can see it |
| Overlays | Every modal, drawer, sheet or wizard step: title, fields (type, required, validation message), primary and secondary action, success result |
| States | Loading, empty (with its copy and call to action), error (with retry), plus every domain state (expired, locked, sold out, no permission, conflict, declined…) |
| Rules | Business rules the UI must show or enforce (limits, deadlines, who may do what) |
| Phone | What changes below 768px (table to cards, sheet instead of modal, sticky action) |

## 2. Weak vs strong

**Page description**

Weak:
> Bookings page: shows the user's bookings with options to manage them.

Strong:
> `bookings`: a member sees every class they booked and changes plans without calling the studio.
> - Tabs: Upcoming (default) · Past.
> - Each row: class name, teacher (avatar + name), "Tue 14 Oct, 07:30 to 08:30", room, StatusPill (Booked info · Waitlisted warning · Attended success · No-show danger · Cancelled neutral).
> - Row actions: **Cancel** (Upcoming only; ConfirmDialog "Cancel this class?"; inside 12 hours the dialog warns "This counts as a used credit"); **Add to calendar**.
> - Empty (Upcoming): "No classes booked yet." + **Browse classes**. Error: ErrorState with **Try again**. Loading: 4 skeleton rows.
> - Phone: rows become cards; Cancel moves into a "…" menu.

**Modal**

Weak:
> A modal to add a member.

Strong:
> **Add member** (Modal md, bottom sheet on phones): First name*, Last name*, Mobile* (PhoneInput, "This number is already registered" on conflict), Email (optional, format check), Membership (Select: Drop-in, 10-class pack, Monthly unlimited), Start date (DateInput, default today). Primary **Add member**, secondary Cancel. Success: toast "Member added" and the new row highlighted for 2 seconds.

**Status**

Weak:
> Show the status with a colour.

Strong:
> StatusPill from the Foundation STATUS map: Booked info · Waitlisted warning · Attended success · No-show danger · Cancelled neutral.

**Mock data**

Weak:
> Add some sample data.

Strong:
> `data.js` holds 24 members with local names and phone formats, 3 teachers, 5 rooms, 60 bookings over the current and next week (every status present at least twice), prices in the local currency with tax included.

## 3. Proportions that work

- A surface prompt covering 10-18 pages is typically 400-900 lines. Under 250 lines for that scope means pages are being summarised, not specified.
- Each page gets roughly 8-40 lines, depending on how many overlays and states it has. A settings-heavy or wizard page needs the upper end.
- The Foundation prompt lists every primitive with its variants, plus a complete STATUS map. A thin component list produces a thin design system, and every surface inherits that.
- The Master stays short (about 100-150 lines): context and rules, no page detail.

## 4. Self-check before delivering

Answer yes to each, or fix the prompt:

- [ ] Every page in the page list has an entry in Key page details (search for each page key).
- [ ] Every entry names real columns and fields, not "relevant information" or "details".
- [ ] Every button that opens something describes what it opens, down to its fields.
- [ ] Every data page lists loading, empty (with copy) and error, plus its domain states.
- [ ] Every status shown uses a value from the STATUS map, with its tone.
- [ ] There is no vague wording like "etc.", "and so on", "various", "as needed", "appropriate", "some", "relevant" left in a spec line.
- [ ] Mock data is sized and described so tables, calendars and charts look real.
- [ ] Anything invented is marked "Proposal for PO approval".
