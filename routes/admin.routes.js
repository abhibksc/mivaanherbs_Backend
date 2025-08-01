

const User = require("../models/auth");
const { Transaction } = require("../models/Transaction");

const mongoose = require("mongoose");
const handleTransactionAbort = require("../utils/handleTransactionError.js"); // adjust path accordingly


const Pincode = require("../models/PincodeSchema.js");


const express = require("express");
const router = express.Router();
const { loginAdmin, getAdminProfile ,getAllOrders} = require("../controllers/admin.controller");
const { authMiddleware } = require("../middleware/auth.middleware");
const dashboard = require('../controllers/admin.controller');
const txnCtrl = require('../controllers/admin.controller');


const { checkRole } = require("../middleware/roles.middleware");
router.use(authMiddleware, checkRole("admin")); // Protect entire admin route

router.get("/profile", getAdminProfile);
router.get('/order', getAllOrders);
router.get('/allusers', async (req, res) => {
  try {
    // Fetch users
    const users = await User.find(
      {},
      {
        username: 1,
        email: 1,
        mobile: 1,
        country_id: 1,
        crt_date: 1,
        is_active: 1,
        wallet_balance: 1,
      }
    ).sort({ crt_date: -1 });

    // Fetch all successful transactions, sorted by creation date
    const transactions = await Transaction.find({ status: 'Success' }).sort({ created_at: 1 });

    // Map user_id => [transactions], and first transaction
    const firstTransactionMap = {};
    const userPackageSums = {};
    let totalPackageSell = 0;

    for (const txn of transactions) {
      const userId = txn.user_id.toString();
      const amount = parseFloat(txn.package_amount?.toString() || '0');

      // Sum all packages
      userPackageSums[userId] = (userPackageSums[userId] || 0) + amount;
      totalPackageSell += amount;

      // Store the first (oldest) transaction only
      if (!firstTransactionMap[userId]) {
        firstTransactionMap[userId] = amount;
      }
    }

    // Prepare response data
    const userData = users.map((user) => {
      const userId = user._id.toString();
      return {
        userId: userId,
        username: user.username,
        email: user.email,
        isVarified_email: false,
        isVarified_mobile: false,
        mobile: user.mobile,
        country: user.country_id,
        joined_at: user.crt_date,
        active: user.is_active,
        balance: user.wallet_balance,
        activated_amount: firstTransactionMap[userId] || 0,
      };
    });

    return res.json({
      total_package_sell: totalPackageSell,
      withdrawals: 0,
      data: userData,
    });

  } catch (err) {
    console.error("User list error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/activate", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { username } = req.body;

    // 1. Fetch user
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_active) return res.status(404).json({ error: "Id Already Activated!" });


    // 2. fetch transaction

    const user_transaction = await Transaction.findOne({ user_id: user._id });
    if (!user_transaction)
      return res
        .status(404)
        .json({
          error:
            "No Transaction Found.. Please Purchase any Item then Activate Account",
        });

    // 2. Activate user
    user.is_active = true;
    const packageAmount = user.package;
    await user.save();
    const dp = Math.round(packageAmount * 0.8017);
    const bv = parseFloat((packageAmount * 0.0079).toFixed(2));

    // 3. updat transaction table where user_transaction._id
    await Transaction.updateOne(
      { user_id: user._id }, // Filter
      {
        $set: {
          dp,
          bv,
          status: "Success",
        },
      }
    );

    // 4. Find sponsor
    const sponsor = await User.findOne({
      my_sponsor_id: user.other_sponsor_id,
    });

    if (sponsor) {
      let sponsorChanged = false;
      d;
      // 6. Direct Income (10%)
      const directIncome = packageAmount * 0.1;
      sponsor.wallet_balance += directIncome;
      sponsor.direct_sponsor_income += directIncome;
      sponsor.income_logs.push({
        type: "Direct",
        amount: directIncome,
        from_user: user._id,
      });
      sponsorChanged = true;

      // 7. Fighter Income (5%)
      if (sponsor.left_user && sponsor.right_user) {
        const fighterIncome = packageAmount * 0.05;
        sponsor.wallet_balance += fighterIncome;
        sponsor.fighter_income += fighterIncome;
        sponsor.income_logs.push({
          type: "Fighter",
          amount: fighterIncome,
          from_user: user.other_sponsor_id,
        });
        sponsorChanged = true;
      }

      // 8. Update BV
      const side =
        String(sponsor.left_user) === String(user._id) ? "left_bv" : "right_bv";
      sponsor[side] += bv;
      sponsorChanged = true;

      // 9. Matching Income (30% of min BV)
      const pairBV = Math.min(sponsor.left_bv, sponsor.right_bv);
      if (pairBV > 0) {
        const matchIncome = pairBV * 0.3;
        sponsor.wallet_balance += matchIncome;
        sponsor.matching_income += matchIncome;
        sponsor.left_bv -= pairBV;
        sponsor.right_bv -= pairBV;
        sponsor.income_logs.push({
          type: "Matching",
          amount: matchIncome,
          from_user: sponsor._id, // from self
        });
        sponsorChanged = true;
      }

      if (sponsorChanged) await sponsor.save();
    }

    return res.json({
      success: true,
      message: "User activated and incomes distributed",
    });
  } catch (err) {
    console.error("Activation Error:", err);
    return await handleTransactionAbort(
      session,
      res,
      400,
      `Activation Error:", ${err}`
    );
  }
});




router.post("/generate-pincode", async (req, res) => {
  const { username, pincode, status } = req.body;

  if (!username || !pincode) {
    return res.status(400).json({ message: "Username and pincode are required" });
  }

  try {
    const existing = await Pincode.findOne({ pincode });

    if (existing) {
      return res.status(409).json({ message: "Pincode already exists" });
    }

    const newPincode = new Pincode({ username, pincode, status });
    await newPincode.save();

    res.status(201).json({ message: "Pincode generated successfully", data: newPincode });
  } catch (error) {
    console.error("Error generating pincode:", error);
    res.status(500).json({ message: "Server error" });
  }
});


// Get all pincodes
router.get("/pincodes", async (req, res) => {
  try {
    const pincodes = await Pincode.find().sort({ createdAt: -1 }); // Optional: Sort by latest
    res.status(200).json({ success: true, data: pincodes });
  } catch (error) {
    console.error("Error fetching pincodes:", error);
    res.status(500).json({ success: false, message: "Server error while fetching pincodes" });
  }
});








// routes/admin.js
router.patch('/user/:id/status', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    await User.updateOne({ _id: id }, { $set : { is_active } });
    console.log(is_active);

    res.json({
      success: true,
      message: `User ${is_active ? 'activated' : 'deactivated'}`,
      _id: id,
      is_active
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Failed to update user status',
      error: err
    });
  }
});


router.get('/total-users', dashboard.getTotalUsers);
router.get('/active-users', dashboard.getActiveUsers);
router.get('/total-income', dashboard.getTotalIncome);
router.get('/recent-signups', dashboard.getRecentSignups);
router.get('/top-earners', dashboard.getTopEarners);
router.get('/income-summary',  dashboard.getIncomeSummary);
router.get('/bv-stats',  dashboard.getBusinessVolumeStats);
router.get('/tree/:userId',  dashboard.getTreeDataForUser); // optional


router.get('/allTxn',  txnCtrl.getAllTransactions);
router.get('/total-volume',  txnCtrl.getTotalTransactionVolume);
router.get('/recent',  txnCtrl.getRecentTransactions);
router.get('/stats',  txnCtrl.getTransactionStats);




module.exports = router;
