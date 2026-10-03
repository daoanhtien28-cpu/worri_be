import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { BanksService } from '../banks/banks.service';
import { WalletsService } from '../wallets/wallets.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import {
  QueryTransactionsDto,
  TransactionSearchType,
  TransactionSortOrder,
  TransactionTypeFilter,
} from './dto/query-transactions.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { TransactionDocument, TransactionStatus } from './schemas/transaction.schema';
import { TransactionsRepository } from './transactions.repository';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactionsRepo: TransactionsRepository,
    private readonly walletsService: WalletsService,
    private readonly banksService: BanksService,
  ) { }

  /**
   * Lấy danh sách giao dịch có bộ lọc và phân trang.
   */
  async getTransactions(userId: string, query: QueryTransactionsDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      userId: new Types.ObjectId(userId),
    };

    // 1. Lọc theo loại giao dịch (전체 / 입금 / 출금)
    if (query.type === TransactionTypeFilter.DEPOSIT) {
      filter.isDeposit = true;
    } else if (query.type === TransactionTypeFilter.WITHDRAWAL) {
      filter.isDeposit = false;
    }

    // 2. Lọc theo thời gian (1M, 3M, 6M hoặc startDate/endDate)
    let startFilterDate: Date | null = null;
    let endFilterDate: Date | null = null;

    if (query.period) {
      const now = new Date();
      endFilterDate = now;
      if (query.period === '1M') {
        startFilterDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      } else if (query.period === '3M') {
        startFilterDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      } else if (query.period === '6M') {
        startFilterDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      }
    } else if (query.startDate || query.endDate) {
      if (query.startDate) {
        startFilterDate = new Date(query.startDate.replace(/\./g, '-'));
      }
      if (query.endDate) {
        const d = new Date(query.endDate.replace(/\./g, '-'));
        d.setHours(23, 59, 59, 999);
        endFilterDate = d;
      }
    }

    if (startFilterDate || endFilterDate) {
      filter.createdAt = {};
      if (startFilterDate) {
        filter.createdAt.$gte = startFilterDate;
      }
      if (endFilterDate) {
        filter.createdAt.$lte = endFilterDate;
      }
    }

    // 3. Tìm kiếm từ khóa (예금주명 / 메모)
    if (query.keyword && query.keyword.trim()) {
      const keyword = query.keyword.trim();
      const regex = new RegExp(keyword, 'i');

      if (query.searchType === TransactionSearchType.HOLDER) {
        filter.$or = [
          { title: regex },
          { 'beneficiaryBank.accountName': regex },
          { 'paymentBank.accountName': regex },
        ];
      } else if (query.searchType === TransactionSearchType.MEMO) {
        filter.content = regex;
      } else {
        filter.$or = [
          { title: regex },
          { content: regex },
          { 'beneficiaryBank.accountName': regex },
        ];
      }
    }

    // 4. Lọc theo khoảng số tiền giao dịch (minAmount, maxAmount)
    if (query.minAmount !== undefined || query.maxAmount !== undefined) {
      const amountFilter: Record<string, number> = {};
      if (query.minAmount !== undefined && !isNaN(Number(query.minAmount))) {
        amountFilter.$gte = Number(query.minAmount);
      }
      if (query.maxAmount !== undefined && !isNaN(Number(query.maxAmount))) {
        amountFilter.$lte = Number(query.maxAmount);
      }
      if (Object.keys(amountFilter).length > 0) {
        filter.transferAmount = amountFilter;
      }
    }

    // 5. Thứ tự sắp xếp (최신순 / 과거순) - theo thời gian giao dịch thực tế
    const sortDirection: 1 | -1 =
      query.sortOrder === TransactionSortOrder.OLDEST ? 1 : -1;
    const sort: Record<string, 1 | -1> = {
      transferTime: sortDirection,
      transferTimeDetail: sortDirection,
      createdAt: sortDirection,
    };

    // Tự động seed dữ liệu mẫu nếu user chưa có giao dịch nào
    // const totalExisting = await this.transactionsRepo.count({
    //   userId: new Types.ObjectId(userId),
    // });
    // if (totalExisting === 0) {
    //   await this.seedInitialTransactionsForUser(userId);
    // }

    const [items, total] = await Promise.all([
      this.transactionsRepo.findWithPagination(filter, sort, skip, limit),
      this.transactionsRepo.count(filter),
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Lấy chi tiết một giao dịch.
   */
  async getTransactionById(userId: string, id: string): Promise<TransactionDocument> {
    const tx = await this.transactionsRepo.findById(id);
    if (!tx) {
      throw new NotFoundException('Giao dịch không tồn tại');
    }
    if (tx.userId.toString() !== userId) {
      throw new ForbiddenException('Bạn không có quyền truy cập giao dịch này');
    }
    return tx;
  }

  /**
   * Tạo giao dịch mới (tự động cập nhật số dư ví).
   */
  async createTransaction(
    userId: string,
    dto: CreateTransactionDto,
  ): Promise<TransactionDocument> {
    const wallet = await this.walletsService.getMyWallet(userId);
    const isDeposit = dto.isDeposit ?? false;
    const fee = dto.fee ?? 0;
    const totalRequired = isDeposit ? 0 : dto.transferAmount + fee;

    if (!isDeposit && wallet.availableBalance < totalRequired) {
      throw new BadRequestException('Số dư khả dụng trong ví không đủ để thực hiện giao dịch');
    }

    // Tính toán số dư mới
    const delta = isDeposit ? dto.transferAmount : -totalRequired;
    const newAvailableBalance = Math.max(0, wallet.availableBalance + delta);
    const newTotalBalance = Math.max(0, wallet.totalBalance + delta);

    // Cập nhật số dư ví
    await this.walletsService.updateMyWallet(userId, {
      availableBalance: newAvailableBalance,
      availableBalanceEdit: newAvailableBalance,
      totalBalance: newTotalBalance,
    });

    // Xác định thông tin ngân hàng nhận
    let receiverBankName = dto.receiverBankName || '국민은행';
    let receiverImageUrl = 'assets/images/bank/bank_kb.png';
    let receiverBankCode = dto.receiverBankCode || 'KB';

    if (dto.receiverBankCode) {
      try {
        const bank = await this.banksService.getBankByCode(dto.receiverBankCode);
        receiverBankName = bank.name;
        receiverImageUrl = bank.imageUrl;
        receiverBankCode = bank.code;
      } catch (_) { }
    }

    // Tạo mã giao dịch & thời gian
    const now = new Date();
    const dateStr =
      dto.transferTime ||
      `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    const timeStr =
      dto.transferTimeDetail ||
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const transferNumber = `1128OTT${Date.now().toString().slice(-9)}`;

    return this.transactionsRepo.save({
      userId: new Types.ObjectId(userId),
      walletId: new Types.ObjectId(wallet.id),
      transferNumber: dto.transferNumber || transferNumber,
      transferChannel: dto.transferChannel || 'Sh 수협',
      transferTypeTag: dto.transferTypeTag || (isDeposit ? '입금' : '체크'),
      title: dto.title,
      content: dto.content || '',
      isDeposit,
      currency: dto.currency || wallet.currency || 'KRW',
      transferAmount: dto.transferAmount,
      fee,
      balanceAfter: dto.balanceAfter ?? newAvailableBalance,
      totalWithdrawalAmount: dto.totalWithdrawalAmount ?? (dto.balanceAfter ?? newAvailableBalance),
      status: (dto.status as TransactionStatus) || TransactionStatus.SUCCESS,
      paymentBank: dto.paymentBank || {
        bankCode: wallet.linkedBankCode || 'SH',
        name: wallet.linkedBankName || '수협',
        imageUrl: wallet.imageUrl || 'assets/images/bank/bank_suhyup.png',
        accountNumber: wallet.accountNumber,
        accountName: wallet.ownerName,
      },
      beneficiaryBank: dto.beneficiaryBank || {
        bankCode: receiverBankCode,
        name: receiverBankName,
        imageUrl: receiverImageUrl,
        accountNumber: dto.receiverAccountNumber || '9876 543 210',
        accountName: dto.receiverName || dto.title,
      },
      transferTime: dateStr,
      transferTimeDetail: timeStr,
    });
  }

  /**
   * Cập nhật thông tin giao dịch (cho phép sửa tất cả thông tin và tự động bù trừ số dư ví).
   */
  async updateTransaction(
    userId: string,
    id: string,
    dto: UpdateTransactionDto,
  ): Promise<TransactionDocument> {
    const tx = await this.getTransactionById(userId, id);
    const wallet = await this.walletsService.getMyWallet(userId);

    // 1. Kiểm tra và tính toán bù trừ số dư nếu thay đổi số tiền, loại giao dịch hoặc phí
    const willChangeAmount =
      dto.transferAmount !== undefined && dto.transferAmount !== tx.transferAmount;
    const willChangeDeposit =
      dto.isDeposit !== undefined && dto.isDeposit !== tx.isDeposit;
    const willChangeFee = dto.fee !== undefined && dto.fee !== tx.fee;

    if (willChangeAmount || willChangeDeposit || willChangeFee) {
      const oldAmount = tx.transferAmount;
      const oldFee = tx.fee || 0;
      const oldContribution = tx.isDeposit ? oldAmount : -(oldAmount + oldFee);

      const newAmount = dto.transferAmount ?? tx.transferAmount;
      const newIsDeposit = dto.isDeposit ?? tx.isDeposit;
      const newFee = dto.fee !== undefined ? dto.fee : oldFee;
      const newContribution = newIsDeposit ? newAmount : -(newAmount + newFee);

      const delta = newContribution - oldContribution;
      const projectedBalance = wallet.availableBalance + delta;

      // Nếu số dư sau điều chỉnh < 0 thì KHÔNG cho sửa, ném lỗi 400
      if (projectedBalance < 0) {
        throw new BadRequestException(
          `Số dư ví không đủ để điều chỉnh giao dịch này. Số dư hiện tại: ${wallet.availableBalance} KRW, mức điều chỉnh cần thêm: ${Math.abs(delta)} KRW.`,
        );
      }

      await this.walletsService.updateMyWallet(userId, {
        availableBalance: projectedBalance,
        availableBalanceEdit: projectedBalance,
        totalBalance: Math.max(0, wallet.totalBalance + delta),
      });

      dto.balanceAfter = projectedBalance;
      dto.totalWithdrawalAmount = projectedBalance;
    }

    // 2. Nếu đổi mã ngân hàng nhận receiverBankCode, tự động cập nhật beneficiaryBank
    if (dto.receiverBankCode) {
      try {
        const bank = await this.banksService.getBankByCode(dto.receiverBankCode);
        if (!dto.beneficiaryBank) {
          dto.beneficiaryBank = {
            bankCode: bank.code,
            name: bank.name,
            imageUrl: bank.imageUrl,
            accountNumber:
              dto.receiverAccountNumber ||
              tx.beneficiaryBank?.accountNumber ||
              '9876 543 210',
            accountName:
              dto.receiverName ||
              dto.title ||
              tx.beneficiaryBank?.accountName ||
              tx.title,
          };
        } else {
          dto.beneficiaryBank.bankCode = bank.code;
          dto.beneficiaryBank.name = bank.name;
          dto.beneficiaryBank.imageUrl = bank.imageUrl;
        }
      } catch (_) { }
    }

    // 3. Cập nhật tất cả thông tin vào database
    const updated = await this.transactionsRepo.update(id, dto);
    if (!updated) {
      throw new NotFoundException('Giao dịch không tồn tại');
    }
    return updated;
  }

  /**
   * Xóa một giao dịch (không hoàn tác số dư ví).
   */
  async deleteTransaction(userId: string, id: string): Promise<{ message: string }> {
    await this.getTransactionById(userId, id);
    await this.transactionsRepo.delete(id);
    return { message: 'Xóa giao dịch thành công' };
  }

  /**
   * Seed dữ liệu mẫu thực tế cho user mới.
   */
  private async seedInitialTransactionsForUser(userId: string) {
    const wallet = await this.walletsService.getMyWallet(userId);
    const initialSamples: Partial<TransactionDocument>[] = [
      {
        userId: new Types.ObjectId(userId),
        walletId: new Types.ObjectId(wallet.id),
        transferNumber: '1128OTT260916001',
        transferChannel: 'Sh 수협',
        transferTypeTag: '체크',
        title: '자연애마트',
        content: '식료품 구매',
        isDeposit: false,
        currency: 'KRW',
        transferAmount: 9470,
        fee: 0,
        balanceAfter: 2686,
        totalWithdrawalAmount: 2686,
        status: TransactionStatus.SUCCESS,
        paymentBank: {
          bankCode: wallet.linkedBankCode || 'SH',
          name: wallet.linkedBankName || '수협',
          imageUrl: wallet.imageUrl || 'assets/images/bank/bank_suhyup.png',
          accountNumber: wallet.accountNumber,
          accountName: wallet.ownerName,
        },
        beneficiaryBank: {
          bankCode: 'KB',
          name: '국민은행',
          imageUrl: 'assets/images/bank/bank_kb.png',
          accountNumber: '128-910734-43507',
          accountName: '자연애마트',
        },
        transferTime: '2026.09.16',
        transferTimeDetail: '18:08:45',
      },
      {
        userId: new Types.ObjectId(userId),
        walletId: new Types.ObjectId(wallet.id),
        transferNumber: '1128OTT260916002',
        transferChannel: 'Sh 수협',
        transferTypeTag: '체크',
        title: 'GS25 편의점',
        content: '음료수',
        isDeposit: false,
        currency: 'KRW',
        transferAmount: 4500,
        fee: 0,
        balanceAfter: 12156,
        totalWithdrawalAmount: 12156,
        status: TransactionStatus.SUCCESS,
        paymentBank: {
          bankCode: wallet.linkedBankCode || 'SH',
          name: wallet.linkedBankName || '수협',
          imageUrl: wallet.imageUrl || 'assets/images/bank/bank_suhyup.png',
          accountNumber: wallet.accountNumber,
          accountName: wallet.ownerName,
        },
        beneficiaryBank: {
          bankCode: 'SHINHAN',
          name: '신한은행',
          imageUrl: 'assets/images/bank/bank_shinhan.png',
          accountNumber: '110-234-567890',
          accountName: 'GS25 편의점',
        },
        transferTime: '2026.09.16',
        transferTimeDetail: '12:30:10',
      },
      {
        userId: new Types.ObjectId(userId),
        walletId: new Types.ObjectId(wallet.id),
        transferNumber: '1128OTT260915001',
        transferChannel: 'Sh 수협',
        transferTypeTag: '입금',
        title: '김환',
        content: '월급 입금',
        isDeposit: true,
        currency: 'KRW',
        transferAmount: 1540000,
        fee: 0,
        balanceAfter: 16656,
        totalWithdrawalAmount: 16656,
        status: TransactionStatus.SUCCESS,
        paymentBank: {
          bankCode: 'KB',
          name: '국민은행',
          imageUrl: 'assets/images/bank/bank_kb.png',
          accountNumber: '9876-543-210',
          accountName: '김환',
        },
        beneficiaryBank: {
          bankCode: wallet.linkedBankCode || 'SH',
          name: wallet.linkedBankName || '수협',
          imageUrl: wallet.imageUrl || 'assets/images/bank/bank_suhyup.png',
          accountNumber: wallet.accountNumber,
          accountName: wallet.ownerName,
        },
        transferTime: '2026.09.15',
        transferTimeDetail: '09:00:00',
      },
    ];

    await this.transactionsRepo.insertMany(initialSamples as any);
  }
}
