import { web3 } from "@nomiclabs/buidler"
import { expectEvent, expectRevert } from "@openzeppelin/test-helpers"
import { default as BigNumber, default as BN } from "bn.js"
import { expect, use } from "chai"
import ClearingHouseArtifact from "../../../build/contracts/ClearingHouse.json"
import {
    AmmFakeInstance,
    ClearingHouseFakeInstance,
    ClearingHouseViewerInstance,
    ERC20FakeInstance,
    InsuranceFundFakeInstance,
    L2PriceFeedMockInstance,
    MetaTxGatewayInstance,
    MinterInstance,
    PerpTokenInstance,
    RewardsDistributionFakeInstance,
    StakingReserveInstance,
    SupplyScheduleFakeInstance,
    TraderWalletContract,
    TraderWalletInstance,
} from "../../../types"
import { ClearingHouse } from "../../../types/web3/ClearingHouse"
import { assertionHelper } from "../../helper/assertion-plugin"
import { Dir, PnlCalcOption, Side } from "../../helper/contract"
import { fullDeploy } from "../../helper/deploy"
import { Decimal, toDecimal, toFullDigit, toFullDigitStr } from "../../helper/number"
import { signEIP712MetaTx } from "../../helper/web3"

use(assertionHelper)

const TraderWallet = artifacts.require("TraderWallet") as TraderWalletContract

describe("ClearingHouse Test", () => {
    let addresses: string[]
    let admin: string
    let alice: string
    let bob: string
    let carol: string
    let relayer: string

    let metaTxGateway: MetaTxGatewayInstance
    let amm: AmmFakeInstance
    let insuranceFund: InsuranceFundFakeInstance
    let quoteToken: ERC20FakeInstance
    let mockPriceFeed!: L2PriceFeedMockInstance
    let rewardsDistribution: RewardsDistributionFakeInstance
    let stakingReserve: StakingReserveInstance
    let clearingHouse: ClearingHouseFakeInstance
    let clearingHouseViewer: ClearingHouseViewerInstance
    let supplySchedule: SupplyScheduleFakeInstance
    let perpToken: PerpTokenInstance
    let minter: MinterInstance

    let traderWallet1: TraderWalletInstance
    let traderWallet2: TraderWalletInstance

    beforeEach(async () => {
        addresses = await web3.eth.getAccounts()
        admin = addresses[0]
        alice = addresses[1]
        bob = addresses[2]
        carol = addresses[3]
        relayer = addresses[4]

        const contracts = await fullDeploy({ sender: admin })
        metaTxGateway = contracts.metaTxGateway
        amm = contracts.amm
        insuranceFund = contracts.insuranceFund
        quoteToken = contracts.quoteToken
        mockPriceFeed = contracts.priceFeed
        rewardsDistribution = contracts.rewardsDistribution
        stakingReserve = contracts.stakingReserve
        clearingHouse = contracts.clearingHouse
        clearingHouseViewer = contracts.clearingHouseViewer
        supplySchedule = contracts.supplySchedule
        perpToken = contracts.perpToken
        clearingHouse = contracts.clearingHouse

        // Each of Alice & Bob have 5000 DAI
        await quoteToken.transfer(alice, toFullDigit(5000, +(await quoteToken.decimals())))
        await quoteToken.transfer(bob, toFullDigit(5000, +(await quoteToken.decimals())))
        await quoteToken.transfer(insuranceFund.address, toFullDigit(5000, +(await quoteToken.decimals())))

        await amm.setMaxHoldingBaseAsset(toDecimal(0))
    })

    async function gotoNextFundingTime(): Promise<void> {
        const nextFundingTime = await amm.nextFundingTime()
        await amm.mock_setBlockTimestamp(nextFundingTime)
    }

    async function forwardBlockTimestamp(time: number): Promise<void> {
        const now = await supplySchedule.mock_getCurrentTimestamp()
        const newTime = now.addn(time)
        await rewardsDistribution.mock_setBlockTimestamp(newTime)
        await amm.mock_setBlockTimestamp(newTime)
        await supplySchedule.mock_setBlockTimestamp(newTime)
        await clearingHouse.mock_setBlockTimestamp(newTime)
        const movedBlocks = time / 15 < 1 ? 1 : time / 15

        const blockNumber = new BigNumber(await amm.mock_getCurrentBlockNumber())
        const newBlockNumber = blockNumber.addn(movedBlocks)
        await rewardsDistribution.mock_setBlockNumber(newBlockNumber)
        await amm.mock_setBlockNumber(newBlockNumber)
        await supplySchedule.mock_setBlockNumber(newBlockNumber)
        await clearingHouse.mock_setBlockNumber(newBlockNumber)
    }

    async function endEpoch(): Promise<void> {
        await forwardBlockTimestamp((await supplySchedule.mintDuration()).toNumber())
        await minter.mintReward()
    }

    async function approve(account: string, spender: string, amount: number): Promise<void> {
        await quoteToken.approve(spender, toFullDigit(amount, +(await quoteToken.decimals())), { from: account })
    }

    async function transfer(from: string, to: string, amount: number): Promise<void> {
        await quoteToken.transfer(to, toFullDigit(amount, +(await quoteToken.decimals())), { from })
    }

    describe("getPersonalPositionWithFundingPayment", () => {
        it("return 0 margin when alice's position is underwater", async () => {
            // given alice takes 10x short position (size: -150) with 60 margin
            await approve(alice, clearingHouse.address, 60)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(60), toDecimal(10), toDecimal(150), {
                from: alice,
            })

            // given the underlying price is $2.1, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(2.1))

            // when the new fundingRate is -50% which means underlyingPrice < snapshotPrice
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(-0.5))

            // then alice need to pay 150 * 50% = $75
            // {size: -150, margin: 300} => {size: -150, margin: 0}
            const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)
            expect(alicePosition.size).to.eq(toFullDigit(-150))
            expect(alicePosition.margin).to.eq(toFullDigit(0))
        })
    })

    describe("payFunding", () => {
        beforeEach(async () => {
            // given alice takes 2x long position (37.5Q) with 300 margin
            await approve(alice, clearingHouse.address, 600)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(300), toDecimal(2), toDecimal(37.5), {
                from: alice,
            })

            // given bob takes 1x short position (-187.5Q) with 1200 margin
            await approve(bob, clearingHouse.address, 1200)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(1200), toDecimal(1), toDecimal(187.5), {
                from: bob,
            })

            const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address)
            // 300 (alice's margin) + 1200 (bob' margin) = 1500
            expect(clearingHouseBaseTokenBalance).eq(toFullDigit(1500, +(await quoteToken.decimals())))
        })

        it("will generate loss for amm when funding rate is positive and amm hold more long position", async () => {
            // given the underlying price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(1.59))

            // when the new fundingRate is 1% which means underlyingPrice < snapshotPrice
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0.01))

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)
            expect(alicePosition.size).to.eq(toFullDigit(37.5))
            expect(alicePosition.margin).to.eq(toFullDigit(299.625))

            // then bob will get 1% of her position size as fundingPayment
            // {balance: -187.5, margin: 1200} => {balance: -187.5, margin: 1201.875}
            const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob)
            expect(bobPosition.size).to.eq(toFullDigit(-187.5))
            expect(bobPosition.margin).to.eq(toFullDigit(1201.875))

            // then fundingPayment will generate 1.5 loss and clearingHouse will withdraw in advanced from insuranceFund
            // clearingHouse: 1500 + 1.5
            // insuranceFund: 5000 - 1.5
            const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address)
            expect(clearingHouseQuoteTokenBalance).to.eq(toFullDigit(1501.5, +(await quoteToken.decimals())))
            const insuranceFundBaseToken = await quoteToken.balanceOf(insuranceFund.address)
            expect(insuranceFundBaseToken).to.eq(toFullDigit(4998.5, +(await quoteToken.decimals())))
        })

        it("funding rate is 1%, 1% then -1%", async () => {
            // given the underlying price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(1.59))
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0.01))

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(299.625),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(299.625),
            )

            // pay 1% funding again
            // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 299.25}
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0.02))
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(299.25),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(299.25),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 299.25} => {balance: 37.5, margin: 299.625}
            await mockPriceFeed.setPrice(toFullDigit(1.61))
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0.01))
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(299.625),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(299.625),
            )
        })

        it("funding rate is 1%, -1% then -1%", async () => {
            // given the underlying price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(1.59))
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0.01))
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(299.625),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(299.625),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 300}
            await gotoNextFundingTime()
            await mockPriceFeed.setPrice(toFullDigit(1.61))
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(0))
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(300),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(300),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 300.375}
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigit(-0.01))
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(300.375),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(300.375),
            )
        })

        it("has huge funding payment profit that doesn't need margin anymore", async () => {
            // given the underlying price is 11.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)

            // then alice will get 2000% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 1050}
            // then alice can withdraw more than her initial margin while remain the enough margin ratio
            await clearingHouse.removeMargin(amm.address, toDecimal(400), { from: alice })

            // margin = 1050 - 400 = 650
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).margin).eq(
                toFullDigit(650),
            )
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).eq(
                toFullDigit(650),
            )
        })

        it("will change nothing if the funding rate is 0", async () => {
            // when the underlying price is $1.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setPrice(toFullDigit(1.6))

            // when the new fundingRate is 0% which means underlyingPrice = snapshotPrice
            await gotoNextFundingTime()
            await clearingHouse.payFunding(amm.address)
            expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(0)

            // then alice's position won't change
            // {balance: 37.5, margin: 300}
            const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)
            expect(alicePosition.size).to.eq(toFullDigit(37.5))
            expect(alicePosition.margin).to.eq(toFullDigit(300))

            // then bob's position won't change
            // {balance: -187.5, margin: 1200}
            const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob)
            expect(bobPosition.size).to.eq(toFullDigit(-187.5))
            expect(bobPosition.margin).to.eq(toFullDigit(1200))

            // clearingHouse: 1500
            // insuranceFund: 5000
            const clearingHouseBaseToken = await quoteToken.balanceOf(clearingHouse.address)
            expect(clearingHouseBaseToken).to.eq(toFullDigit(1500, +(await quoteToken.decimals())))
            const insuranceFundBaseToken = await quoteToken.balanceOf(insuranceFund.address)
            expect(insuranceFundBaseToken).to.eq(toFullDigit(5000, +(await quoteToken.decimals())))
        })
    })

    describe("add/remove margin", () => {
        beforeEach(async () => {
            await approve(alice, clearingHouse.address, 2000)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })

            const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address)
            expect(clearingHouseBaseTokenBalance).eq(toFullDigit(60, +(await quoteToken.decimals())))
            const allowance = await quoteToken.allowance(alice, clearingHouse.address)
            expect(allowance).to.eq(toFullDigit(2000 - 60, +(await quoteToken.decimals())))
        })

        it("add margin", async () => {
            const receipt = await clearingHouse.addMargin(amm.address, toDecimal(80), { from: alice })
            await expectEvent.inTransaction(receipt.tx, clearingHouse, "MarginAdded", {
                sender: alice,
                amm: amm.address,
                amount: toFullDigit(80),
            })
            await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                from: alice,
                to: clearingHouse.address,
                value: toFullDigit(80, +(await quoteToken.decimals())),
            })
            expect((await clearingHouse.getPosition(amm.address, alice)).margin).to.eq(toFullDigit(140))
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).to.eq(
                toFullDigit(140),
            )
        })

        it("remove margin", async () => {
            const removedMargin = 20

            // remove margin 20
            const receipt = await clearingHouse.removeMargin(amm.address, toDecimal(removedMargin), {
                from: alice,
            })
            await expectEvent.inTransaction(receipt.tx, clearingHouse, "MarginRemoved", {
                sender: alice,
                amm: amm.address,
                amount: toFullDigit(removedMargin),
            })
            await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                from: clearingHouse.address,
                to: alice,
                value: toFullDigit(20, +(await quoteToken.decimals())),
            })

            // 60 - 20
            expect((await clearingHouse.getPosition(amm.address, alice)).margin).to.eq(toFullDigit(40))
            // 60 - 20
            expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).to.eq(
                toFullDigit(40),
            )
        })

        it("Force error, remove margin - not enough position margin", async () => {
            // margin is 60, try to remove more than 60
            const removedMargin = 61

            await expectRevert(
                clearingHouse.removeMargin(amm.address, toDecimal(removedMargin), { from: alice }),
                "Margin is not enough",
            )
        })

        it("Force error, remove margin - not enough ratio (4%)", async () => {
            const removedMargin = 36

            // remove margin 36
            // remain margin -> 60 - 36 = 24
            // margin ratio -> 24 / 600 = 4%
            await expectRevert(
                clearingHouse.removeMargin(amm.address, toDecimal(removedMargin), { from: alice }),
                "marginRatio not enough",
            )
        })
    })

    describe("getMarginRatio", () => {
        it("get margin ratio", async () => {
            await approve(alice, clearingHouse.address, 2000)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice)
            expect(marginRatio).to.eq(toFullDigit(0.1))
        })

        it("get margin ratio - long", async () => {
            await approve(alice, clearingHouse.address, 2000)

            // Alice's Balance in clearingHouse: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice long by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 + 250) * (100 + y) = 1000 * 100
            // so y = -20, quoteAsset price = 12.5

            // when Alice buy 25 long(Side.BUY) with 10 times leverage should get 20 quote tokens
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // Bob short 15 base token with leverage 10x
            // (1250 - 150) * (80 + y) = 1000 * 100
            // y = 10.9090909091
            // Bob get 10.9090909091 quote tokens
            // AMM: 1100, 90.9090909091
            await approve(bob, clearingHouse.address, 2000)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // (1100 + x) * (90.9090909091 + 37.5) = 1000 * 100
            // x = 37.49999
            // alice's current unrealizedPnl is -51.639344262295081965
            // margin maintenance is around -10.6557377049180327%
            const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice)
            expect(marginRatio).to.eq("-106557377049180327")
        })

        it("get margin ratio - short", async () => {
            await approve(alice, clearingHouse.address, 2000)
            // Alice's Balance in clearingHouse: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice short by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 - 250) * (100 + y) = 1000 * 100
            // so y = 33.3333333333

            // when Alice buy 25 short with 10 times leverage should get 33.3333333333 quote tokens
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(25), toDecimal(10), toDecimal(33.4), {
                from: alice,
            })

            // Bob long 15 base token with leverage 10x
            // (750 + 150) * (133.3333333333 + y) = 1000 * 100
            // y = -22.222222222
            // Bob get 22.222222222 quote tokens
            // AMM: 900, 111.1111111111
            await approve(bob, clearingHouse.address, 2000)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // (900 + x) * (111.1111111111 - 33.3333333333) = 1000 * 100
            // x = 385.7142857139
            // alice's current unrealizedPnl is -135.7142857139
            // margin maintenance is around -0.4428571429
            const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice)
            expect(marginRatio.d).to.eq("-442857142857142857")
        })

        it("get margin ratio - higher twap", async () => {
            await approve(alice, clearingHouse.address, 2000)
            await approve(bob, clearingHouse.address, 2000)

            const timestamp = new BigNumber(await amm.mock_getCurrentTimestamp())

            // Alice's Balance in clearingHouse: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice long by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 + 250) * (100 + y) = 1000 * 100
            // so y = -20, quoteAsset price = 12.5

            // when Alice buy 25 long(Side.BUY) with 10 times leverage should get 20 quote tokens
            let newTimestamp = timestamp.addn(15)
            await amm.mock_setBlockTimestamp(newTimestamp)
            await amm.mock_setBlockNumber(10002)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // Bob short 15 base token with leverage 10x
            // (1250 - 150) * (80 + y) = 1000 * 100
            // y = 10.9090909091
            // Bob get 10.9090909091 quote tokens
            // AMM: 1100, 90.9090909091
            newTimestamp = newTimestamp.addn(15 * 62)
            await amm.mock_setBlockTimestamp(newTimestamp)
            await amm.mock_setBlockNumber(10064)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice's current unrealized TWAP Pnl is -0.860655737704918033
            // margin maintenance is around 9.6557377049180327%
            newTimestamp = newTimestamp.addn(15)
            await amm.mock_setBlockTimestamp(newTimestamp)
            await amm.mock_setBlockNumber(10065)
            const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice)
            expect(marginRatio.d).to.eq("96557377049180327")
        })
    })

    describe("liquidate", () => {
        enum Action {
            OPEN = 0,
            CLOSE = 1,
            LIQUIDATE = 2,
        }

        beforeEach(async () => {
            await forwardBlockTimestamp(900)
        })

        it("liquidate when the position (long) is lower than the maintenance margin", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15) // 15 secs. later
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
            // TWAP PnL = (70.42 * 855 + 84.62 * 15 + 99.96 * 15 + 84.62 * 15) / 900 - 100 ~= -28.61
            // Use spot price PnL since -15.38 > -28.61
            await forwardBlockTimestamp(15)
            const positionBefore = await clearingHouse.getPosition(amm.address, alice)
            expect(positionBefore.openNotional).to.eq(toFullDigit(100))

            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.SPOT_PRICE)).to.eq(
                new BN("-15384615384615384623"),
            )
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.TWAP)).to.eq(
                new BN("-28611412062116287475"),
            )

            // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
            // marginRatio = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
            // then anyone (eg. carol) can liquidate alice's position
            const receipt = await clearingHouse.liquidate(amm.address, alice, { from: carol })
            expect(receipt)
                .to.emit("PositionChanged")
                .withArgs({
                    amm: amm.address,
                    trader: alice,
                    side: Side.SELL.toString(),
                    positionNotional: "84615384615384615377",
                    exchangedPositionSize: "7575757575757575757",
                    fee: "0",
                    positionSizeAfter: "0",
                    realizedPnl: "-15384615384615384623",
                })

            // verify carol get her reward
            // = positionNotional * liquidationFeeRatio = 84.62 * 0.05 = 4.231
            expect(await quoteToken.balanceOf(carol)).to.eq("4230769")

            // verify alice's position got liquidate and she lost 20 DAI
            const positionAfter = await clearingHouse.getPosition(amm.address, alice)
            expect(positionAfter.size).eq(0)

            // verify alice's remaining balance
            const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            expect(margin).to.eq(0)
            expect(await quoteToken.balanceOf(alice)).to.eq(toFullDigit(4980, +(await quoteToken.decimals())))
            // verify insuranceFund remaining
            // insuranceFundPnl = remainMargin - liquidationFee = 4.62 - 4.231 = 0.38
            // 5000 + 0.38 = 5000.384615384615384622
            expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(new BN("5000384615"))
        })

        it("liquidate when the position (short) is lower than the maintenance margin", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            // when bob create a 20 margin * 5x short position when 11.1111111111 quoteAsset = 100 DAI
            // AMM after: 900 : 111.1111111111

            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 13.8888888889 quoteAsset = 100 DAI
            // AMM after: 800 : 125
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL
            // spot price Pnl = 21.951219512195121950
            // twap price Pnl = -24.583333333333333332
            // clearingHouse only has 20 + 20 = 40, need to return Bob's margin 20 and PnL 21.951.
            // So, InsuranceFund to pay 1.95121..., remaining 4998.049
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: bob })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = openNotional - positionValue = 100 - 121.95 = -21.95
            // TWAP PnL = 100 - (161.29 * 855 + 128.57 * 15 + 100 * 15 + 121.95 * 15) / 900 ~= -59.06
            // Use spot price PnL since -21.95 > -59.06
            await forwardBlockTimestamp(15)
            const positionBefore = await clearingHouse.getPosition(amm.address, alice)
            expect(positionBefore.openNotional).to.eq(toFullDigit(100))
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.SPOT_PRICE)).to.eq(
                new BN("-21951219512195121954"),
            )
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.TWAP)).to.eq(
                new BN("-59067850586339964783"),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-21.95)) / 100 = -0.0195 < 0.05 = minMarginRatio
            // then anyone (eg. carol) can liquidate alice's position
            await clearingHouse.liquidate(amm.address, alice, { from: carol })

            // verify carol get her reward
            // = positionNotional * liquidationFeeRatio = 121.95 * 0.05 = 6.0975
            expect(await quoteToken.balanceOf(carol)).to.eq("6097560")

            // verify alice's position got liquidate and she lost 20 DAI
            const positionAfter = await clearingHouse.getPosition(amm.address, alice)
            expect(positionAfter.size).eq(0)

            // verify alice's remaining balance
            const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            expect(margin).to.eq(0)

            // verify insuranceFund remaining
            // remainMargin = margin + unrealizedPnL = 20 + (-21.95121)  = -1.95121 - it's negative which means badDebt
            // insuranceFund already prepaid for alice's bad debt, so no need to withdraw for bad debt
            // insuranceFundPnl = remainMargin - liquidationFee = 0 - 6.0975 = -6.0975
            // (after closing Bob's position) 4998.049 - 6.0975 ~= 4991.9515
            expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4991951221")
        })

        it("force error, position not liquidatable due to TWAP over maintenance margin", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(600)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
            // TWAP PnL = (70.42 * 270 + 84.62 * 15 + 99.96 * 600 + 84.62 * 15) / 900 - 100 ~= -9.39
            // Use TWAP price PnL since -9.39 > -15.38
            await forwardBlockTimestamp(15)
            const positionBefore = await clearingHouse.getPosition(amm.address, alice)
            expect(positionBefore.openNotional).to.eq(toFullDigit(100))
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.SPOT_PRICE)).to.eq(
                new BN("-15384615384615384623"),
            )
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.TWAP)).to.eq(
                new BN("-9386059949440231138"),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-9.39)) / 100 = 0.1061 > 0.05 = minMarginRatio
            // then anyone (eg. carol) calling liquidate() would get an exception
            await expectRevert(
                clearingHouse.liquidate(amm.address, alice, { from: carol }),
                "Margin ratio is larger than min requirement",
            )
        })

        it("force error, position not liquidatable due to SPOT price over maintenance margin", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: alice,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 100 - 100 = 0
            // TWAP PnL = (83.3333333333 * 885 + 100 * 15) / 900 - 100 = -16.39
            // Use spot price PnL since 0 > -16.39
            await forwardBlockTimestamp(15)
            const positionBefore = await clearingHouse.getPosition(amm.address, alice)
            expect(positionBefore.openNotional).to.eq(toFullDigit(100))

            // workaround: rounding error, should be 0 but it's actually 10 wei
            const spotPnl = await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.SPOT_PRICE)
            expect(new BN(spotPnl.d.toString()).divn(10)).to.eq("0")
            expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.TWAP)).to.eq(
                new BN("-16388888888888888891"),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + 0) / 100 = 0.2 > 0.05 = minMarginRatio
            // then anyone (eg. carol) calling liquidate() would get an exception
            await expectRevert(
                clearingHouse.liquidate(amm.address, alice, { from: carol }),
                "Margin ratio is larger than min requirement",
            )
        })

        it("can't liquidate an empty position", async () => {
            await expectRevert(clearingHouse.liquidate(amm.address, alice, { from: carol }), "positionSize is 0")
        })

        async function openSmallPositions(
            account: string,
            side: Side,
            margin: Decimal,
            leverage: Decimal,
            count: number,
        ): Promise<void> {
            for (let i = 0; i < count; i++) {
                await clearingHouse.openPosition(amm.address, side, margin, leverage, toDecimal(0), {
                    from: account,
                })
                await forwardBlockTimestamp(15)
            }
        }

        it("liquidate one position within the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.148))

            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            // alice get: 90.9090909091 - 83.3333333333 = 7.5757575758
            await openSmallPositions(alice, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // liquidate -> return base asset to AMM
            // 90.9090909091 + 7.5757575758 = 98.484848484848484854
            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            // values can be retrieved with amm.quoteAssetReserve() & amm.baseAssetReserve()
            expect(await clearingHouse.liquidate(amm.address, alice, { from: carol })).to.emit("PositionLiquidated")

            const baseAssetReserve = await amm.baseAssetReserve()
            const quoteAssetReserve = await amm.quoteAssetReserve()
            expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(98.4848)
            expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1015.38)
        })

        it("liquidate two positions within the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.148))
            traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await approve(carol, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.2), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: quote = 1150
            await openSmallPositions(carol, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when alice create a 10 margin * 5x long position
            // AMM after: quote = 1200
            await openSmallPositions(alice, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            await traderWallet1.twoLiquidations(amm.address, alice, carol)

            const baseAssetReserve = await amm.baseAssetReserve()
            const quoteAssetReserve = await amm.quoteAssetReserve()
            expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(98.4848)
            expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1015.38)
        })

        it("liquidate three positions within the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.22))
            traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await transfer(admin, relayer, 1000)
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await approve(carol, clearingHouse.address, 100)
            await approve(relayer, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.2), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: quote = 1150 : 86.9565217391
            await openSmallPositions(carol, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when alice create a 10 margin * 5x long position
            // AMM after: quote = 1200 : 83.3333333333
            await openSmallPositions(alice, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when relayer create a 10 margin * 5x long position
            // AMM after: quote = 1250 : 80
            // alice + carol + relayer get: 90.9090909091 - 80 = 10.9090909091
            await openSmallPositions(relayer, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1150 : 86.9565217391, price: 13.225
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // 86.9565217391 + 10.9090909091 = 97.8656126482
            // AMM after: close to 1021.8093699518 : 97.8656126482, price: 10.4409438852
            // fluctuation: (13.225 - 10.4409438852) / 13.225 = 0.2105146401
            await traderWallet1.threeLiquidations(amm.address, alice, carol, relayer)

            const baseAssetReserve = await amm.baseAssetReserve()
            const quoteAssetReserve = await amm.quoteAssetReserve()
            expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(97.8656)
            expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1021.8)
        })

        it("force error, liquidating one position while exceeding the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.147))

            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await openSmallPositions(alice, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            await expectRevert(
                clearingHouse.liquidate(amm.address, alice, { from: carol }),
                "price is over fluctuation limit",
            )
        })

        it("force error, liquidate two positions while exceeding the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.147))
            traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await approve(carol, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.2), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.BUY, toDecimal(10), toDecimal(5), 2)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1150 : 86.9565
            await openSmallPositions(carol, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when alice create a 10 margin * 5x long position
            // AMM after: 1200 : 83.3333333, price: 14.4
            await openSmallPositions(alice, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(10), toDecimal(5), 2)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            await expectRevert(
                traderWallet1.twoLiquidations(amm.address, alice, carol),
                "price is over fluctuation limit",
            )
        })

        it("force error, liquidate three positions while exceeding the fluctuation limit", async () => {
            await amm.setFluctuationLimit(toDecimal(0.21))
            traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await transfer(admin, relayer, 1000)
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)
            await approve(carol, clearingHouse.address, 100)
            await approve(relayer, clearingHouse.address, 100)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.2), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.BUY, toDecimal(10), toDecimal(5), 2)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1150 : 86.9565
            await openSmallPositions(carol, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when alice create a 10 margin * 5x long position
            // AMM after: 1200 : 83.3333333, price: 14.4
            await openSmallPositions(alice, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when relayer create a 10 margin * 5x long position
            // AMM after: quote = 1250
            await openSmallPositions(relayer, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1150 : 86.9565, price: 13.225
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: close to 1021.8093699518 : 97.8656126482, price: 10.4409438852
            // fluctuation: (13.225 - 10.4409438852) / 13.225 = 0.2105146401
            await expectRevert(
                traderWallet1.threeLiquidations(amm.address, alice, carol, relayer),
                "price is over fluctuation limit",
            )
        })

        describe("liquidator front run hack", () => {
            beforeEach(async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, clearingHouse.address, 1000)
                await approve(bob, clearingHouse.address, 1000)
                await approve(carol, clearingHouse.address, 1000)
                await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })
            })

            async function makeAliceLiquidatableByShort(): Promise<void> {
                await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                    from: alice,
                })
                await forwardBlockTimestamp(15)
                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
                // marginRatio of alice = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
            }

            async function makeAliceLiquidatableByLong(): Promise<void> {
                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: alice,
                })
                await forwardBlockTimestamp(15)
                await clearingHouse.closePosition(amm.address, toDecimal(0), { from: bob })
                await forwardBlockTimestamp(15)
                // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-21.95)) / 100 = -0.0195 < 0.05 = minMarginRatio
            }

            it("liquidator can open position and liquidate in the next block", async () => {
                await makeAliceLiquidatableByShort()

                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await forwardBlockTimestamp(15)
                expect(await clearingHouse.liquidate(amm.address, alice, { from: carol })).to.emit("PositionLiquidated")
            })

            it("can open position (short) and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByShort()

                // short to make alice loss more and make insuranceFund loss more
                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await clearingHouse.liquidate(amm.address, alice, { from: carol })
                await expectRevert(
                    clearingHouse.closePosition(amm.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position (long) and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByLong()

                // short to make alice loss more and make insuranceFund loss more
                await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await clearingHouse.liquidate(amm.address, alice, { from: carol })
                await expectRevert(
                    clearingHouse.closePosition(amm.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByShort()

                // open a long position, make alice loss less
                await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(1), toDecimal(0), {
                    from: carol,
                })
                await clearingHouse.liquidate(amm.address, alice, { from: carol })
                await expectRevert(
                    clearingHouse.closePosition(amm.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position (even the same side, short), but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByLong()

                // open a short position, make alice loss less
                await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(1), toDecimal(0), {
                    from: carol,
                })
                await clearingHouse.liquidate(amm.address, alice, { from: carol })
                await expectRevert(
                    clearingHouse.closePosition(amm.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("liquidator can't open and liquidate position in the same block, even from different msg.sender", async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, clearingHouse.address, 1000)
                await approve(bob, clearingHouse.address, 1000)
                await approve(carol, clearingHouse.address, 1000)
                await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

                traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)
                traderWallet2 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

                await approve(alice, traderWallet1.address, 500)
                await approve(alice, traderWallet2.address, 500)
                await transfer(alice, traderWallet1.address, 500)
                await transfer(alice, traderWallet2.address, 500)

                await makeAliceLiquidatableByShort()
                await traderWallet1.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await traderWallet2.liquidate(amm.address, alice, { from: bob })
                await expectRevert(traderWallet1.closePosition(amm.address, { from: bob }), "only one action allowed")
            })

            it("liquidator can't open and liquidate position in the same block, even from different tx.origin", async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, clearingHouse.address, 1000)
                await approve(bob, clearingHouse.address, 1000)
                await approve(carol, clearingHouse.address, 1000)
                await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

                traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)
                traderWallet2 = await TraderWallet.new(clearingHouse.address, quoteToken.address)

                await approve(alice, traderWallet1.address, 500)
                await approve(alice, traderWallet2.address, 500)
                await transfer(alice, traderWallet1.address, 500)
                await transfer(alice, traderWallet2.address, 500)

                await makeAliceLiquidatableByShort()
                await traderWallet1.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await traderWallet2.liquidate(amm.address, alice, { from: carol })
                await expectRevert(traderWallet1.closePosition(amm.address, { from: admin }), "only one action allowed")
            })
        })
    })

    describe("clearingHouse", () => {
        beforeEach(async () => {
            await approve(alice, clearingHouse.address, 100)
            const clearingHouseBaseTokenBalance = await quoteToken.allowance(alice, clearingHouse.address)
            expect(clearingHouseBaseTokenBalance).eq(toFullDigit(100, +(await quoteToken.decimals())))
        })

        it("clearingHouse should take openPosition meta tx", async () => {
            await approve(bob, clearingHouse.address, 200)

            const clearingHouseWeb3Contract = new web3.eth.Contract(
                ClearingHouseArtifact.abi,
                clearingHouse.address,
            ) as ClearingHouse

            const metaTx = {
                from: bob,
                to: clearingHouse.address,
                functionSignature: clearingHouseWeb3Contract.methods
                    .openPosition(
                        amm.address,
                        Side.SELL,
                        { d: toFullDigitStr(20) },
                        { d: toFullDigitStr(5) },
                        { d: toFullDigitStr(11.12) },
                    )
                    .encodeABI(),
                nonce: 0,
            }

            const signedResponse = await signEIP712MetaTx(
                bob,
                {
                    name: "Perp",
                    version: "1",
                    chainId: 1234, // L1 chain ID as defined in fullDeploy()
                    verifyingContract: metaTxGateway.address,
                },
                metaTx,
            )
            await metaTxGateway.executeMetaTransaction(
                metaTx.from,
                metaTx.to,
                metaTx.functionSignature,
                signedResponse.r,
                signedResponse.s,
                signedResponse.v,
                {
                    from: relayer,
                },
            )

            const position = await clearingHouse.getPosition(amm.address, bob)
            expect(position.openNotional.d).to.eq(toFullDigitStr(20 * 5))
        })

        it("clearingHouse should have enough balance after close position", async () => {
            await approve(bob, clearingHouse.address, 200)

            // AMM after: 900 : 111.1111111111
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // AMM after: 800 : 125
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(25), toDecimal(4), toDecimal(13.89), {
                from: alice,
            })
            // 20(bob's margin) + 25(alice's margin) = 45
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(
                toFullDigit(45, +(await quoteToken.decimals())),
            )

            // when bob close his position (11.11)
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL = 21.951219512195121950
            // need to return Bob's margin 20 and PnL 21.951 = 41.951
            // clearingHouse balance: 45 - 41.951 = 3.048...
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: bob })
            expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(
                toFullDigit(5000, +(await quoteToken.decimals())),
            )
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq("3048781")
        })

        it("clearingHouse doesn't have enough balance after close position and ask for InsuranceFund", async () => {
            await approve(bob, clearingHouse.address, 200)

            // AMM after: 900 : 111.1111111111
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // AMM after: 800 : 125
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })
            // 20(bob's margin) + 20(alice's margin) = 40
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(
                toFullDigit(40, +(await quoteToken.decimals())),
            )

            // when bob close his position (11.11)
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL = 21.951219512195121950
            // need to return Bob's margin 20 and PnL 21.951 = 41.951
            // clearingHouse balance: 40 - 41.951 = -1.95...
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: bob })
            expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4998048781")
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigit(0))
        })

        it("force error, open an opposite position but existing margin not enough to pay PnL", async () => {
            // deposit to 30
            await approve(bob, clearingHouse.address, 30)

            // AMM after 1250 : 80...
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // Then alice short 250,  price will decrease
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            /**
             * Now Bob's position is {margin: 25}
             * positionValue of 20 quoteAsset is 166.67 now
             */
            // Bob's realizedPnl = 166.67 - 250 = -83.33, he lost all his margin(25)
            // realizedPnl(58.33) > bob's allowance(5) + margin(25)
            // which means Bob has no money to pay the loss to close the position
            await expectRevert(
                clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(25), toDecimal(10), toDecimal(0), {
                    from: bob,
                }),
                "reduce an underwater position",
            )
        })
    })

    describe("close position slippage limit", () => {
        beforeEach(async () => {
            await forwardBlockTimestamp(900)
        })

        // Case 1
        it("closePosition, originally long, (amount should pay = 118.03279) at the limit of min quote amount = 118", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            // when bob create a 20 margin * 5x short position when 9.0909091 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 7.5757609 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.5), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 1081.96721 : 92.4242424
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(118), { from: bob })

            const quoteAssetReserve = await amm.quoteAssetReserve()
            const baseAssetReserve = await amm.baseAssetReserve()
            expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1081.96)
            expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.4242)
        })

        // Case 2
        it("closePosition, originally short, (amount should pay = 78.048) at the limit of max quote amount = 79", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            // when bob create a 20 margin * 5x short position when 11.1111111111 quoteAsset = 100 DAI
            // AMM after: 900 : 111.1111111111
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 13.8888888889 quoteAsset = 100 DAI
            // AMM after: 800 : 125
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 878.0487804877 : 113.8888888889
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(79), { from: bob })

            const quoteAssetReserve = await amm.quoteAssetReserve()
            const baseAssetReserve = await amm.baseAssetReserve()
            expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 1000).to.eq(878.048)
            expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 1000).to.eq(113.888)
        })

        // expectRevert section
        // Case 1
        it("force error, closePosition, originally long, less than min quote amount = 119", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9), {
                from: bob,
            })

            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.5), {
                from: alice,
            })

            await forwardBlockTimestamp(15)
            await expectRevert(
                clearingHouse.closePosition(amm.address, toDecimal(119), { from: bob }),
                "Less than minimal quote token",
            )
        })

        // Case 2
        it("force error, closePosition, originally short, more than max quote amount = 78", async () => {
            await approve(alice, clearingHouse.address, 100)
            await approve(bob, clearingHouse.address, 100)

            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            await forwardBlockTimestamp(15)
            await expectRevert(
                clearingHouse.closePosition(amm.address, toDecimal(78), { from: bob }),
                "More than maximal quote token",
            )
        })
    })

    describe("migrate liquidity", () => {
        beforeEach(async () => {
            await transfer(admin, carol, 5000)

            await approve(alice, clearingHouse.address, 2000)
            await approve(bob, clearingHouse.address, 2000)
            await approve(carol, clearingHouse.address, 2000)
        })

        it("add liquidity with positive position size", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })

            // total position = 16.66...
            // baseReserve = 83.33...
            // quoteReserve = 1200

            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAMount: (100 * 1000) / (16.66 + 83.33) - 1200 = -200
            // -->  (4 * 1000 * 100) / (2400 + -200) - 166.666 = 15.151...
            // expansionRatio = 15.151 / 16.66 = 0.909...
            const receipt = await amm.migrateLiquidity(toDecimal(2), { from: admin })

            // new baseReserve = 166.66
            // new quoteReserve = 2400
            const newBaseReserve = await amm.baseAssetReserve()
            const newQuoteReserve = await amm.quoteAssetReserve()
            expect(newBaseReserve).eq("166666666666666666668")
            expect(newQuoteReserve).eq(toFullDigit(2400))

            expectEvent(receipt, "LiquidityChanged", {
                positionMultiplier: "909090909090909090",
            })

            const liquidityChangedSnapshot = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot[2]).eq("15151515151515151514") // totalPositionSize

            // alice new position: 9.09 * 0.909 = 8.264
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("8264462809917355363")
            // bob new position: 13.986 * 0.909 = 12.71
            const posBob = await clearingHouse.getPosition(amm.address, bob)
            expect(posBob.size).to.eq("12714558169103623636")
            // carol new position: -6.41 * 0.909 = -5.82
            const posCarol = await clearingHouse.getPosition(amm.address, carol)
            expect(posCarol.size).to.eq("-5827505827505827500")

            const allPos = new BigNumber(posAlice.size.d)
                .add(new BigNumber(posBob.size.d))
                .add(new BigNumber(posCarol.size.d))
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq(allPos.abs())
        })

        it("add liquidity with negative position size", async () => {
            // alice position: -11.11
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -31.74
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // total position = -42.85
            // baseReserve = 142.85
            // quoteReserve = 700

            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAMount: (100 * 1000) / (-42.85 + 142.85) - 700 = 300
            // -->  (4 * 1000 * 100) / (1400 + 300) - 285.71 = 50.42...
            // expansionRatio = -50.42 / -42.897 = 1.176
            const receipt = await amm.migrateLiquidity(toDecimal(2))

            // new baseReserve = 285.71
            // new quoteReserve = 1400
            // await amm.migrateLiquidity(toDecimal(2))
            const newBaseReserve = await amm.baseAssetReserve()
            const newQuoteReserve = await amm.quoteAssetReserve()
            expect(newBaseReserve).eq("285714285714285714288")
            expect(newQuoteReserve).eq(toFullDigit(1400))

            expectEvent(receipt, "LiquidityChanged", {
                positionMultiplier: "1176470588235294117",
            })

            const liquidityChangedSnapshot = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot[2]).eq("-50420168067226890758") // totalPositionSize

            // alice new position: 9.09 * 0.909 = 8.264
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("-13071895424836601301")
            // bob new position: 13.986 * 0.909 = 12.71
            const posBob = await clearingHouse.getPosition(amm.address, bob)
            expect(posBob.size).to.eq("-37348272642390289428")

            const allPos = new BigNumber(posAlice.size.d).add(new BigNumber(posBob.size.d))
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq(allPos.abs())
        })

        it("add liquidity and open a new position to update existing ones", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // total position = 9.09
            // baseReserve = 90.909
            // quoteReserve = 1100

            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAMount: (100 * 1000) / (9.09 + 90.90) - 1100 = -100
            // -->  (4 * 1000 * 100) / (2200 + -100) - 181.81 = 8.658
            // expansionRatio = 8.658 / 9.09 = 0.952
            const migrateReceipt = await amm.migrateLiquidity(toDecimal(2))
            expectEvent(migrateReceipt, "LiquidityChanged", {
                positionMultiplier: "952380952380952380",
            })

            // new baseReserve = 181.818
            // new quoteReserve = 2200
            // position size: 7.905
            const receipt = await clearingHouse.openPosition(
                amm.address,
                Side.BUY,
                toDecimal(10),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )
            await expectEvent.inTransaction(receipt.tx, clearingHouse, "PositionAdjusted", {
                amm: amm.address,
                trader: alice,
                newPositionSize: "8658008658008657999",
                oldLiquidityBasis: toFullDigit(1),
                newLiquidityBasis: "952380952380952380",
            })

            const pos = await clearingHouse.getPosition(amm.address, alice)
            expect(pos.size).to.eq("16563146997929606615")

            const allPos = new BigNumber(pos.size.d)
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq(allPos.abs())
        })

        it("add liquidity twice", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // total position = 9.09
            // baseReserve = 90.909
            // quoteReserve = 1100

            // new baseReserve = 181.818
            // new quoteReserve = 2200
            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAMount: (100 * 1000) / (9.09 + 90.90) - 1100 = -100
            // -->  (4 * 1000 * 100) / (2200 + -100) - 181.81 = 8.658
            // expansionRatio = 8.658 / 9.09 = 0.952
            // await amm.migrateLiquidity(toDecimal(2))
            await amm.migrateLiquidity(toDecimal(2))

            // new baseReserve = 363.636
            // new quoteReserve = 4400
            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAmount: (181.818 * 2200) / (8.65 + 181.818) - 2200 = -99.87
            // -->  (363.63 * 4400) / (4400 + -99.87) - 363.636 = 8.45
            // expansionRatio = 8.45 / 8.65 = 0.976
            const receipt = await amm.migrateLiquidity(toDecimal(2))
            expectEvent(receipt, "LiquidityChanged", {
                positionMultiplier: "976744186046511627",
            })

            const liquidityChangedSnapshot = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot[2]).eq("8456659619450317124") // totalPositionSize

            // alice new position: 8.65 * 0.975 = 8.45...
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("8456659619450317099")

            // position size: 8.08..
            const receipt2 = await clearingHouse.openPosition(
                amm.address,
                Side.BUY,
                toDecimal(10),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )
            await expectEvent.inTransaction(receipt2.tx, clearingHouse, "PositionAdjusted", {
                amm: amm.address,
                trader: alice,
                oldLiquidityBasis: toFullDigit(1),
                newLiquidityBasis: "930232558139534881", // 9.09 * 0.93 ~= 9.08
            })

            const pos = await clearingHouse.getPosition(amm.address, alice)
            expect(pos.size).to.eq("16537467700258397907")
        })

        it("add liquidity twice, double then half", async () => {
            // given alice opens position with 250 quoteAsset for 20 baseAsset
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // when double the liquidity
            await amm.migrateLiquidity(toDecimal(2))

            // when half the liquidity
            await amm.migrateLiquidity(toDecimal(0.5))

            const liquidityChangedSnapshot = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot[2]).eq("19999999999999999999") // totalPositionSize

            // then alice.position should be the same - with rounding error
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("19999999999999999960")

            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq("19999999999999999962")
        })

        it("still able to migrate liquidity without any position opened", async () => {
            await amm.migrateLiquidity(toDecimal(2))

            const liquidityChangedSnapshot = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot[2]).eq(0) // totalPositionSize
        })

        it("should be able to add liquidity even there is no outstanding position", async () => {
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(1), toDecimal(0), {
                from: carol,
            })
            const pos = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, carol)
            const p = await amm.getOutputPrice(Dir.ADD_TO_AMM, pos.size)
            await clearingHouse.openPosition(amm.address, Side.SELL, p, toDecimal(1), toDecimal(0), {
                from: bob,
            })

            const liquidityChangedSnapshot1 = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot1[2]).eq(0) // totalPositionSize

            // when double the liquidity
            const r = await amm.migrateLiquidity(toDecimal(2))

            expectEvent(r, "LiquidityChanged", {
                positionMultiplier: toFullDigit(1),
            })

            const liquidityChangedSnapshot2 = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot2[2]).eq(0) // totalPositionSize
        })

        it("open position, add liquidity then close position", async () => {
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // when double the liquidity
            await amm.migrateLiquidity(toDecimal(2))

            // alice close
            await clearingHouse.closePosition(amm.address, toDecimal(0), {
                from: alice,
            })
            expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice)).size).eq(0)
        })

        it("open position after adding liquidity, then add liquidity twice", async () => {
            // when double the liquidity
            await amm.migrateLiquidity(toDecimal(2))

            // then alice open position
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // then half the liquidity
            await amm.migrateLiquidity(toDecimal(0.5))

            // then alice can get her entire margin (250) back if she close her position
            const alicePreBalance = await quoteToken.balanceOf(alice)
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: alice })
            const alicePostBalance = await quoteToken.balanceOf(alice)
            expect(alicePostBalance.sub(alicePreBalance)).eq("24999999")
        })

        it.skip("should return equal quote amount after migrate liquidity", async () => {
            // given bob open a position at first
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // when double the liquidity
            await amm.migrateLiquidity(toDecimal(2))

            // then alice open position
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // then half the liquidity
            await amm.migrateLiquidity(toDecimal(0.5))

            // then alice can get her entire margin (250) back if she close her position
            const alicePreBalance = await quoteToken.balanceOf(alice)
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: alice })
            const alicePostBalance = await quoteToken.balanceOf(alice)

            // but got 56249999
            expect(alicePostBalance.sub(alicePreBalance)).eq("24999999")
        })

        it("add liquidity and liquidity ratio is less than 1", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })

            // total position = 16.66...
            // baseReserve = 83.33...
            // quoteReserve = 1200
            const baseReserve = await amm.baseAssetReserve()
            const quoteReserve = await amm.quoteAssetReserve()

            // new baseReserve = 41.666
            // new quoteReserve = 600
            // await amm.migrateLiquidity(toDecimal(0.5))

            // newAllPositionSize = newK / (quoteReserve + accQuoteAssetAMount) -  baseReserve
            // accQuoteAssetAMount: (100 * 1000) / (16.66 + 83.33) - 1200 = -200
            // -->  (0.25 * 1000 * 100) / (600 + -200) - 41.666 = 20.833
            // expansionRatio = 20.833 / 16.66 = 1.25
            const receipt = await amm.migrateLiquidity(toDecimal(0.5))
            expectEvent(receipt, "LiquidityChanged", {
                positionMultiplier: "1249999999999999999",
            })

            // new baseReserve = 41.666
            // new quoteReserve = 600
            // await amm.migrateLiquidity(toDecimal(0.5))
            const newBaseReserve = await amm.baseAssetReserve()
            const newQuoteReserve = await amm.quoteAssetReserve()
            expect(newBaseReserve).eq("41666666666666666667")
            expect(newQuoteReserve).eq(toFullDigit(600))

            // 0 is total position: 15.15,
            // 1 is expansionRatio: 0.909

            const liquidityChangedSnapshot2 = await amm.liquidityChangedSnapshot()
            expect(liquidityChangedSnapshot2[2]).eq("20833333333333333332") // totalPositionSize

            // alice new position: 9.09 * 1.25 = 11.363
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("11363636363636363627")
            // bob new position: 13.986 * 1.25 = 17.482
            const posBob = await clearingHouse.getPosition(amm.address, bob)
            expect(posBob.size).to.eq("17482517482517482503")
            // carol new position: -6.41 * 1.25 = -8.012
            const posCarol = await clearingHouse.getPosition(amm.address, carol)
            expect(posCarol.size).to.eq("-8012820512820512814")

            const allPos = new BigNumber(posAlice.size.d)
                .add(new BigNumber(posBob.size.d))
                .add(new BigNumber(posCarol.size.d))
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            // ignore the least digit
            expect(new BigNumber(deltaBaseAsset.d).abs().divn(10)).to.eq(allPos.abs().divn(10))
        })

        it("add liquidity position notional should be the same", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            const posBob = await clearingHouse.getPosition(amm.address, bob)
            const posCarol = await clearingHouse.getPosition(amm.address, carol)

            await amm.migrateLiquidity(toDecimal(2), { from: admin })

            const posAlice1 = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.openNotional).to.eq(posAlice1.openNotional)
            const posBob1 = await clearingHouse.getPosition(amm.address, bob)
            expect(posBob.openNotional).to.eq(posBob1.openNotional)
            const posCarol1 = await clearingHouse.getPosition(amm.address, carol)
            expect(posCarol.openNotional).to.eq(posCarol1.openNotional)
        })

        it("add liquidity and margin ratio should the same if no one trades", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const ratio1 = await clearingHouse.getMarginRatio(amm.address, alice)
            await amm.migrateLiquidity(toDecimal(2), { from: admin })
            const ratio2 = await clearingHouse.getMarginRatio(amm.address, alice)
            // ratio and ratio2 should be the same, but rounding issue...
            expect(ratio1).to.eq("99999999999999999")
            expect(ratio2).to.eq("99999999999999998")
        })

        it("add liquidity and close position", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))
            const posMigrated = await clearingHouse.getPosition(amm.address, alice)

            const r = await clearingHouse.closePosition(amm.address, toDecimal(0), { from: alice })
            await expectEvent.inTransaction(r.tx, clearingHouse, "PositionChanged", {
                exchangedPositionSize: posMigrated.size.d,
            })

            const posClosed = await clearingHouse.getPosition(amm.address, alice)
            expect(posClosed.size).to.eq("0")
        })

        it("add liquidity and open a reverse but smaller position size", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -4.228,
            // new position size will be 8.658 - 4.228 ~= 4.43
            const receipt = await clearingHouse.openPosition(
                amm.address,
                Side.SELL,
                toDecimal(5),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )

            const pos = await clearingHouse.getPosition(amm.address, alice)
            expect(pos.size).to.eq("4429678848283499436")

            const allPos = new BigNumber(pos.size.d)
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq(allPos.abs())
        })

        it("add liquidity and open a larger reverse position", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            const receipt = await clearingHouse.openPosition(
                amm.address,
                Side.SELL,
                toDecimal(15),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )

            const pos = await clearingHouse.getPosition(amm.address, alice)
            expect(pos.size).to.eq("-4645760743321718942")

            const allPos = new BigNumber(pos.size.d)
            const deltaBaseAsset = await amm.getBaseAssetDeltaThisFundingPeriod()
            expect(new BigNumber(deltaBaseAsset.d).abs()).to.eq(allPos.abs())
        })

        it("add liquidity and liquidate", async () => {
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // AMM after: 1100 : 90.9090909091
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15) // 15 secs. later
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position 7.575, remaining position 1.515
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // expansion ratio: 0.952
            // alice's migrated position size = 7.21
            await amm.migrateLiquidity(toDecimal(2))

            const receipt = await clearingHouse.liquidate(amm.address, alice, { from: carol })
            expectEvent(receipt, "PositionLiquidated", {
                positionSize: "7215007215007214999",
            })

            const pos = await clearingHouse.getPosition(amm.address, alice)
            expect(pos.size).to.eq("0")
        })

        // todo migrate settle position to amm
        it("add liquidity and settle position", async () => {
            // alice position: -25, price 8
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                from: alice,
            })
            // bob position: 25, price 8
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(100), toDecimal(2), toDecimal(0), {
                from: bob,
            })
            // carol position: 9.09, price 11
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(100), toDecimal(1), toDecimal(0), {
                from: carol,
            })
            // settle price is 11

            // migrated position size
            // alice: -23.81, open price: 200 / 23.81 = 8.4
            // bob: 23.81, open price: 200 / 23.81 = 8.4
            // carol: 8.65, open price: 100 / 8.65 = 11.56
            // settle price: 11.55
            await amm.migrateLiquidity(toDecimal(2))
            await amm.shutdown()

            // left value: -23.81 * (11.55 - 8.4) + 100 = 25
            const receiptAlice = await clearingHouse.settlePosition(amm.address, { from: alice })
            await expectEvent.inTransaction(receiptAlice.tx, quoteToken, "Transfer", {
                value: "25000000",
            })
            // left value: 23.81 * (11.55 - 8.4) + 100 = 175
            const receiptBob = await clearingHouse.settlePosition(amm.address, { from: bob })
            await expectEvent.inTransaction(receiptBob.tx, quoteToken, "Transfer", {
                value: "174999999",
            })
            // left value: 8.65 * (11.55 - 11.55) + 100 ~= 100
            const receiptCarol = await clearingHouse.settlePosition(amm.address, { from: carol })
            await expectEvent.inTransaction(receiptCarol.tx, quoteToken, "Transfer", {
                value: "99999999",
            })
            const posAlice = await clearingHouse.getPosition(amm.address, alice)
            expect(posAlice.size).to.eq("0")
            const posBob = await clearingHouse.getPosition(amm.address, bob)
            expect(posBob.size).to.eq("0")
            const posCarol = await clearingHouse.getPosition(amm.address, carol)
            expect(posCarol.size).to.eq("0")
        })

        it("add liquidity and add margin", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            const receipt = await clearingHouse.addMargin(amm.address, toDecimal(10), { from: alice })
            await expectEvent.inTransaction(receipt.tx, clearingHouse, "PositionAdjusted", {
                newPositionSize: "8658008658008657999",
                oldLiquidityBasis: toFullDigit(1),
                newLiquidityBasis: "952380952380952380",
            })
        })

        it("add liquidity and remove margin", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            const receipt = await clearingHouse.addMargin(amm.address, toDecimal(5), { from: alice })
            await expectEvent.inTransaction(receipt.tx, clearingHouse, "PositionAdjusted", {
                newPositionSize: "8658008658008657999",
                oldLiquidityBasis: toFullDigit(1),
                newLiquidityBasis: "952380952380952380",
            })
        })

        it("add liquidity, close position and then open position, liquidity changed index should be new", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            const pos1 = await clearingHouse.getPosition(amm.address, alice)
            expect(pos1.liquidityBasis).to.eq(toFullDigit(1))

            // migrated position size = 8.658
            await amm.migrateLiquidity(toDecimal(2))

            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: alice })
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const pos2 = await clearingHouse.getPosition(amm.address, alice)
            expect(pos2.liquidityBasis).to.eq("952380952380952380")
        })

        // because of rounding issue the result is a few wei different compare to expected results
        it.skip("add liquidity and its positionNotional and unrealizedPnl should the same if no one trades", async () => {
            // alice position: 9.090
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const positionNotionalAndUnrealizedPnl = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
                amm.address,
                alice,
                PnlCalcOption.SPOT_PRICE,
            )
            await amm.migrateLiquidity(toDecimal(2), { from: admin })
            const positionNotionalAndUnrealizedPnl2 = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
                amm.address,
                alice,
                PnlCalcOption.SPOT_PRICE,
            )
            // positionNotionalAndUnrealizedPnl and positionNotionalAndUnrealizedPnl2 should be the same
            expect(positionNotionalAndUnrealizedPnl[1]).to.eq(positionNotionalAndUnrealizedPnl2[1])
            expect(positionNotionalAndUnrealizedPnl[0]).to.eq(positionNotionalAndUnrealizedPnl2[0])
        })
    })

    describe("pausable functions", () => {
        it("pause by admin", async () => {
            const error = "Pausable: paused"
            await clearingHouse.pause()
            await expectRevert(
                clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(1), toDecimal(1), toDecimal(0)),
                error,
            )
            await expectRevert(clearingHouse.addMargin(amm.address, toDecimal(1)), error)
            await expectRevert(clearingHouse.removeMargin(amm.address, toDecimal(1)), error)
            await expectRevert(clearingHouse.closePosition(amm.address, toDecimal(0)), error)
        })

        it("can't pause by non-admin", async () => {
            await expectRevert(clearingHouse.pause({ from: alice }), "PerpFiOwnableUpgrade: caller is not the owner")
        })

        it("pause then unpause by admin", async () => {
            await quoteToken.approve(clearingHouse.address, toFullDigit(2), { from: alice })
            await clearingHouse.pause()
            await clearingHouse.unpause()
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(1), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await clearingHouse.addMargin(amm.address, toDecimal(1), {
                from: alice,
            })
            await clearingHouse.removeMargin(amm.address, toDecimal(1), {
                from: alice,
            })
            await clearingHouse.closePosition(amm.address, toDecimal(0), {
                from: alice,
            })
        })

        it("pause by admin and can not being paused by non-admin", async () => {
            await clearingHouse.pause()
            await expectRevert(clearingHouse.pause({ from: alice }), "PerpFiOwnableUpgrade: caller is not the owner")
        })
    })

    describe("restriction mode", () => {
        enum Action {
            OPEN = 0,
            CLOSE = 1,
            LIQUIDATE = 2,
        }

        // copy from above so skip the comment for calculation
        async function makeLiquidatableByShort(addr: string): Promise<void> {
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
                from: admin,
            })
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
                from: addr,
            })
            await forwardBlockTimestamp(15)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                from: admin,
            })
            await forwardBlockTimestamp(15)
        }

        beforeEach(async () => {
            traderWallet1 = await TraderWallet.new(clearingHouse.address, quoteToken.address)
            await transfer(admin, traderWallet1.address, 1000)

            await approve(admin, clearingHouse.address, 1000)
            await approve(alice, clearingHouse.address, 1000)
            await approve(bob, clearingHouse.address, 1000)
            await clearingHouse.setMaintenanceMarginRatio(toDecimal(0.2))
        })

        it("trigger restriction mode", async () => {
            // just make some trades to make bob's bad debt larger than 0 by checking args[8] of event
            // price become 11.03 after openPosition
            await clearingHouse.openPosition(amm.address, Side.BUY, toDecimal(10), toDecimal(5), toDecimal(0), {
                from: bob,
            })
            await forwardBlockTimestamp(15)
            // price become 7.23 after openPosition
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(0), { from: bob })

            const blockNumber = new BigNumber(await clearingHouse.mock_getCurrentBlockNumber())
            expect(await clearingHouse.isInRestrictMode(amm.address, blockNumber)).eq(true)
            expect(await clearingHouse.isInRestrictMode(amm.address, blockNumber.subn(1))).eq(false)
        })

        // there are 3 types of actions, open, close and liquidate
        // So test cases will be combination of any two of them,
        // except close-close because it doesn't make sense.
        it("open then close", async () => {
            await expectRevert(
                traderWallet1.multiActions(
                    Action.OPEN,
                    true,
                    Action.CLOSE,
                    amm.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("open then open", async () => {
            await expectRevert(
                traderWallet1.multiActions(
                    Action.OPEN,
                    true,
                    Action.OPEN,
                    amm.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("open then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await clearingHouse.liquidate(amm.address, alice)
        })

        it("liquidate then open", async () => {
            await makeLiquidatableByShort(alice)
            await forwardBlockTimestamp(15)
            await traderWallet1.multiActions(
                Action.LIQUIDATE,
                true,
                Action.OPEN,
                amm.address,
                Side.BUY,
                toDecimal(60),
                toDecimal(10),
                toDecimal(0),
                alice,
            )
        })

        it("failed if open, liquidate then close", async () => {
            await makeLiquidatableByShort(alice)
            await forwardBlockTimestamp(15)
            await traderWallet1.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(5), toDecimal(0))
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.CLOSE,
                    amm.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("liquidate then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await makeLiquidatableByShort(bob)
            await forwardBlockTimestamp(15)
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.LIQUIDATE,
                    amm.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "positionSize is 0",
            )
        })

        it("close then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(1), toDecimal(0), {
                from: bob,
            })
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(0))
            await clearingHouse.liquidate(amm.address, alice)
        })

        it("failed when close then liquidate then open", async () => {
            await makeLiquidatableByShort(alice)
            await traderWallet1.openPosition(amm.address, Side.SELL, toDecimal(10), toDecimal(5), toDecimal(0))
            await forwardBlockTimestamp(15)
            await traderWallet1.closePosition(amm.address)
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.OPEN,
                    amm.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("close then open", async () => {
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(1), toDecimal(1), toDecimal(0))
            await forwardBlockTimestamp(15)
            await clearingHouse.closePosition(amm.address, toDecimal(0))
            await clearingHouse.openPosition(amm.address, Side.SELL, toDecimal(1), toDecimal(1), toDecimal(0))
        })
    })
})