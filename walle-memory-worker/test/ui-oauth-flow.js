async page => {
  // Open the local fixture origin before running. Test values come only from it.
  const origin = new URL(page.url()).origin;
  const config = await (await page.request.get(origin+'/fixture/config')).json();
  const failures=[]; page.on('pageerror',()=>failures.push('page script failed'));
  await page.goto(config.authorization_url);
  await page.locator('#login-section:not([hidden])').waitFor();
  await page.locator('#email').fill(config.email);
  await page.locator('#password').fill(config.password);
  await page.locator('#login-submit').click();
  await page.locator('#consent-section:not([hidden])').waitFor();
  if (!await page.locator('#approve').isDisabled()) throw new Error('Consent must require explicit space choice');
  if (await page.locator('#space').inputValue() !== '') throw new Error('No space may be preselected');
  const option = await page.locator('#space option').allTextContents();
  const target = option.find(text=>text.startsWith('Browser Alpha'));
  if (!target) throw new Error('Owned space missing');
  await page.locator('#space').selectOption({label:target});
  await page.locator('#approve').click();
  await page.getByText('Local OAuth, MCP and refresh passed.',{exact:true}).waitFor();
  await page.goto(origin+'/account');
  await page.locator('#connection-list').getByText('Browser test client',{exact:true}).waitFor();
  await page.locator('#connection-list').getByRole('button',{name:'撤销连接',exact:true}).click();
  await page.locator('#confirm-action').click();
  await page.getByText('连接已撤销。此应用需要重新授权才能访问空间。',{exact:true}).waitFor();
  const check=await page.request.get(origin+'/fixture/check-revoked');
  if (!check.ok()) throw new Error('Revocation did not invalidate both tokens');
  if (failures.length) throw new Error('Browser script error');
  console.log('PASS: browser login, explicit space consent, PKCE callback, MCP CRUD, refresh and account revocation');
}
