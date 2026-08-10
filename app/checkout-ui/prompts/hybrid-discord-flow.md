### 3. The Recommended "Hybrid" Architecture

Instead of pushing everything to the web, you should build a hybrid flow that keeps the user in Discord as much as possible, only breaking them out when necessary.

**Scenario A: The user selects "Split Evenly"**

1. **Discord:** The bot asks, "Who is splitting this?" using a Discord `UserSelectMenu`.
    
2. **Discord:** The organizer selects 3 friends.
    
3. **Engine:** Your background worker divides the total by 4.
    
4. **Discord:** The bot drops a message: "@User1, @User2, @User3, you owe $15.00 each. [Pay Here]"
    
5. **Next.js:** The "Pay Here" button is a URL button linking straight to your Next.js Stripe Checkout page (`/checkout/[tab_id]?user=[user_id]`).
    

**Scenario B: The user selects "Itemized Split"**

1. **Discord:** The bot immediately says: "Great! Click here to assign items to your friends."
    
2. **Next.js:** The organizer clicks a URL button linking to `/split/[tab_id]?token=XYZ`.
    
3. **Next.js:** The organizer does the drag-and-drop mapping on their phone browser and clicks "Confirm".
    
4. **Engine:** The Next.js app hits your backend, updates the Supabase tables, and triggers the Discord bot to send the final invoices to the channel.
    
5. **Next.js:** The users click the invoice links to go to the checkout page.
    