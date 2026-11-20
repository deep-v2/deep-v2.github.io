-- Project pages show "Description" (description) and "Notes" (notes, formerly "instructions").
ALTER TABLE projects RENAME COLUMN instructions TO notes;
