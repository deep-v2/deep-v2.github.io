-- The default accent is now white. Accounts still on the old default profile colour (mint) move to white;
-- new accounts get white from the API.
UPDATE users SET profile_color = '#ffffff' WHERE lower(profile_color) = '#1fd1a0';
