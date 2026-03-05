# Contributing

Thanks for contributing to Transient Recall.

## Ground Rules

- All contributions are submitted under `AGPL-3.0-only`.
- Keep pull requests focused and scoped.
- Do not include secrets, credentials, private URLs, customer data, or internal infrastructure details.
- Do not add code copied from incompatible licenses.

## Development

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

Run checks before opening a PR:

```bash
npm run smoke
```

## Pull Request Checklist

- Explain the problem and rationale.
- Document behavior changes in `README.md` or docs.
- Confirm no private-only data is introduced.
- Confirm AGPL header/SPDX policy is respected for new files.

## Legal

By submitting a contribution, you represent that you have the right to submit it under AGPL-3.0.
